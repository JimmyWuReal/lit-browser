// Lit's way to Apple's passkey sheet: iCloud Keychain and other passkey apps,
// a phone nearby, and security keys. Only a browser Apple has given the
// com.apple.developer.web-browser.public-key-credential entitlement may use
// it, so `available()` says whether this copy of Lit has it.
//
// main (src/main.js) checks each request first (src/webauthn.js): this only
// turns it into Apple's, shows the sheet on the page's window and hands back
// what comes of it. One request at a time, as there is one sheet.
//
// From JavaScript (built by `npm run native`, loaded from
// native/build/Release/passkeys.node):
//   available()                      true when the sheet can be used
//   perform(window, request, done)   window: BrowserWindow.getNativeWindowHandle()
//                                    done({ error: { code, message } }) or done({ credential })
//   cancel()                         closes the sheet; done gets error 1001
// Error codes are ASAuthorizationError's (1001 cancelled, 1006 a passkey the
// site excluded is there), or LIT_* below.

#include <node_api.h>
#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/Security.h>

static NSString *const ENTITLEMENT = @"com.apple.developer.web-browser.public-key-credential";

// Errors of our own, beside ASAuthorizationError's.
enum { LIT_BUSY = 1, LIT_BAD_REQUEST = 2, LIT_NO_WINDOW = 3, LIT_NO_RESULT = 4 };

@interface LitPasskeyRequest : NSObject <ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) ASAuthorizationController *controller;
@property (nonatomic, assign) napi_threadsafe_function done;
@end

// The request the sheet shows, if any.
static LitPasskeyRequest *current = nil;

// --- Reading the request ---------------------------------------------------

static napi_value property(napi_env env, napi_value object, const char *name) {
  napi_value value = NULL;
  bool has = false;
  if (!object || napi_has_named_property(env, object, name, &has) != napi_ok || !has) return NULL;
  napi_get_named_property(env, object, name, &value);
  napi_valuetype type;
  napi_typeof(env, value, &type);
  return type == napi_undefined || type == napi_null ? NULL : value;
}

static NSString *string(napi_env env, napi_value object, const char *name) {
  napi_value value = property(env, object, name);
  size_t length = 0;
  if (!value || napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return nil;
  char *buffer = malloc(length + 1);
  napi_get_value_string_utf8(env, value, buffer, length + 1, &length);
  NSString *result = [[NSString alloc] initWithBytes:buffer length:length encoding:NSUTF8StringEncoding];
  free(buffer);
  return result;
}

static NSData *bytes(napi_env env, napi_value object, const char *name) {
  napi_value value = property(env, object, name);
  void *data = NULL;
  size_t length = 0;
  bool isBuffer = false;
  if (!value || napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer) return nil;
  napi_get_buffer_info(env, value, &data, &length);
  return [NSData dataWithBytes:data length:length];
}

static BOOL flag(napi_env env, napi_value object, const char *name) {
  napi_value value = property(env, object, name);
  bool result = false;
  if (value) napi_get_value_bool(env, value, &result);
  return result;
}

// Each element of an array, or nothing.
static void each(napi_env env, napi_value object, const char *name, void (^block)(napi_value)) {
  napi_value array = property(env, object, name);
  uint32_t length = 0;
  bool isArray = false;
  if (!array || napi_is_array(env, array, &isArray) != napi_ok || !isArray) return;
  napi_get_array_length(env, array, &length);
  for (uint32_t i = 0; i < length; i++) {
    napi_value element;
    napi_get_element(env, array, i, &element);
    block(element);
  }
}

static NSArray *platformDescriptors(napi_env env, napi_value request, const char *name) {
  NSMutableArray *descriptors = [NSMutableArray array];
  each(env, request, name, ^(napi_value descriptor) {
    NSData *id = bytes(env, descriptor, "id");
    if (id) [descriptors addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:id]];
  });
  return descriptors;
}

static NSArray *keyDescriptors(napi_env env, napi_value request, const char *name) {
  NSMutableArray *descriptors = [NSMutableArray array];
  each(env, request, name, ^(napi_value descriptor) {
    NSData *id = bytes(env, descriptor, "id");
    // On any transport: what a site stored is only a hint, and a key may have
    // been used another way since.
    if (id) [descriptors addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc] initWithCredentialID:id transports:ASAuthorizationAllSupportedPublicKeyCredentialDescriptorTransports()]];
  });
  return descriptors;
}

static ASAuthorizationPublicKeyCredentialUserVerificationPreference userVerification(NSString *value) {
  if ([value isEqualToString:@"required"]) return ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
  if ([value isEqualToString:@"discouraged"]) return ASAuthorizationPublicKeyCredentialUserVerificationPreferenceDiscouraged;
  return ASAuthorizationPublicKeyCredentialUserVerificationPreferencePreferred;
}

static ASAuthorizationPublicKeyCredentialAttestationKind attestation(NSString *value) {
  if ([value isEqualToString:@"direct"]) return ASAuthorizationPublicKeyCredentialAttestationKindDirect;
  if ([value isEqualToString:@"indirect"]) return ASAuthorizationPublicKeyCredentialAttestationKindIndirect;
  if ([value isEqualToString:@"enterprise"]) return ASAuthorizationPublicKeyCredentialAttestationKindEnterprise;
  return ASAuthorizationPublicKeyCredentialAttestationKindNone;
}

static ASAuthorizationPublicKeyCredentialResidentKeyPreference residentKey(NSString *value) {
  if ([value isEqualToString:@"required"]) return ASAuthorizationPublicKeyCredentialResidentKeyPreferenceRequired;
  if ([value isEqualToString:@"preferred"]) return ASAuthorizationPublicKeyCredentialResidentKeyPreferencePreferred;
  return ASAuthorizationPublicKeyCredentialResidentKeyPreferenceDiscouraged;
}

// Apple's requests for one of src/webauthn.js's (see its nativeRequest), or
// nil when something it needs is missing.
static NSArray<ASAuthorizationRequest *> *requestsOf(napi_env env, napi_value request) API_AVAILABLE(macos(14.4)) {
  NSString *kind = string(env, request, "kind");
  NSString *rpId = string(env, request, "rpId");
  NSString *origin = string(env, request, "origin");
  NSData *challenge = bytes(env, request, "challenge");
  if (!kind || !rpId || !origin || !challenge) return nil;

  ASPublicKeyCredentialClientData *clientData = [[ASPublicKeyCredentialClientData alloc] initWithChallenge:challenge origin:origin];
  clientData.crossOrigin = ASPublicKeyCredentialClientDataCrossOriginValueSameOriginWithAncestors;
  ASAuthorizationPublicKeyCredentialUserVerificationPreference verification = userVerification(string(env, request, "userVerification"));
  BOOL platform = flag(env, request, "platform");
  BOOL securityKey = flag(env, request, "securityKey");
  NSMutableArray<ASAuthorizationRequest *> *requests = [NSMutableArray array];

  if ([kind isEqualToString:@"create"]) {
    napi_value user = property(env, request, "user");
    NSData *userId = bytes(env, user, "id");
    NSString *name = string(env, user, "name");
    NSString *displayName = string(env, user, "displayName") ?: @"";
    if (!userId || !name) return nil;
    if (platform) {
      ASAuthorizationPlatformPublicKeyCredentialProvider *provider = [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
      ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *create = [provider createCredentialRegistrationRequestWithClientData:clientData name:name userID:userId];
      create.displayName = displayName;
      create.userVerificationPreference = verification;
      create.attestationPreference = attestation(string(env, request, "attestation"));
      create.excludedCredentials = platformDescriptors(env, request, "exclude");
      create.shouldShowHybridTransport = flag(env, request, "hybrid");
      [requests addObject:create];
    }
    if (securityKey) {
      ASAuthorizationSecurityKeyPublicKeyCredentialProvider *provider = [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
      ASAuthorizationSecurityKeyPublicKeyCredentialRegistrationRequest *create = [provider createCredentialRegistrationRequestWithClientData:clientData displayName:displayName name:name userID:userId];
      NSMutableArray *parameters = [NSMutableArray array];
      each(env, request, "algorithms", ^(napi_value element) {
        int32_t algorithm;
        if (napi_get_value_int32(env, element, &algorithm) == napi_ok) [parameters addObject:[[ASAuthorizationPublicKeyCredentialParameters alloc] initWithAlgorithm:algorithm]];
      });
      create.credentialParameters = parameters;
      create.excludedCredentials = keyDescriptors(env, request, "exclude");
      create.residentKeyPreference = residentKey(string(env, request, "residentKey"));
      create.userVerificationPreference = verification;
      create.attestationPreference = attestation(string(env, request, "attestation"));
      [requests addObject:create];
    }
  } else if ([kind isEqualToString:@"get"]) {
    if (platform) {
      ASAuthorizationPlatformPublicKeyCredentialProvider *provider = [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
      ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *get = [provider createCredentialAssertionRequestWithClientData:clientData];
      get.allowedCredentials = platformDescriptors(env, request, "allow");
      get.userVerificationPreference = verification;
      get.shouldShowHybridTransport = flag(env, request, "hybrid");
      [requests addObject:get];
    }
    if (securityKey) {
      ASAuthorizationSecurityKeyPublicKeyCredentialProvider *provider = [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
      ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *get = [provider createCredentialAssertionRequestWithClientData:clientData];
      get.allowedCredentials = keyDescriptors(env, request, "allow");
      get.userVerificationPreference = verification;
      [requests addObject:get];
    }
  }
  return requests.count ? requests : nil;
}

// --- Handing back the result -----------------------------------------------

// NSData as Buffers, NSString as strings, NSNumber as numbers or booleans,
// and arrays and dictionaries of them.
static napi_value toJS(napi_env env, id value) {
  napi_value result;
  if ([value isKindOfClass:[NSData class]]) {
    NSData *data = value;
    napi_create_buffer_copy(env, data.length, data.bytes, NULL, &result);
  } else if ([value isKindOfClass:[NSString class]]) {
    napi_create_string_utf8(env, [value UTF8String], NAPI_AUTO_LENGTH, &result);
  } else if (value == (id)kCFBooleanTrue || value == (id)kCFBooleanFalse) {
    napi_get_boolean(env, [value boolValue], &result);
  } else if ([value isKindOfClass:[NSNumber class]]) {
    napi_create_double(env, [value doubleValue], &result);
  } else if ([value isKindOfClass:[NSArray class]]) {
    NSArray *array = value;
    napi_create_array_with_length(env, array.count, &result);
    for (NSUInteger i = 0; i < array.count; i++) napi_set_element(env, result, (uint32_t)i, toJS(env, array[i]));
  } else if ([value isKindOfClass:[NSDictionary class]]) {
    napi_create_object(env, &result);
    [(NSDictionary *)value enumerateKeysAndObjectsUsingBlock:^(NSString *key, id object, BOOL *stop) {
      napi_set_named_property(env, result, key.UTF8String, toJS(env, object));
    }];
  } else {
    napi_get_null(env, &result);
  }
  return result;
}

// Runs on the JavaScript thread with what `finish` sent.
static void callDone(napi_env env, napi_value done, void *context, void *data) {
  NSDictionary *result = (__bridge_transfer NSDictionary *)data;
  if (!env || !done) return;
  napi_value undefined, argument;
  napi_get_undefined(env, &undefined);
  argument = toJS(env, result);
  napi_call_function(env, undefined, done, 1, &argument, NULL);
}

// Answers a request once; later answers (the sheet's, after cancel) are dropped.
static void finish(LitPasskeyRequest *request, NSDictionary *result) {
  LitPasskeyRequest *kept = request;
  if (current == kept) current = nil;
  // The controller may still be calling its delegate, so both outlive this
  // turn of the run loop.
  dispatch_async(dispatch_get_main_queue(), ^{ (void)kept; });
  if (!kept.done) return;
  napi_call_threadsafe_function(kept.done, (__bridge_retained void *)result, napi_tsfn_nonblocking);
  napi_release_threadsafe_function(kept.done, napi_tsfn_release);
  kept.done = NULL;
}

static NSDictionary *failure(NSInteger code, NSString *message) {
  return @{ @"error": @{ @"code": @(code), @"message": message ?: @"" } };
}

static NSArray<NSString *> *transportNames(NSArray<ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransport> *transports) {
  NSMutableArray *names = [NSMutableArray array];
  for (NSString *transport in transports) {
    if ([transport isEqualToString:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportUSB]) [names addObject:@"usb"];
    else if ([transport isEqualToString:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportNFC]) [names addObject:@"nfc"];
    else if ([transport isEqualToString:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportBluetooth]) [names addObject:@"ble"];
  }
  return names;
}

// What the page gets back: src/webauthn.js's `credential`, or nil if the
// sheet gave too little.
static NSDictionary *resultOf(id credential) API_AVAILABLE(macos(14.4)) {
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  if ([credential conformsToProtocol:@protocol(ASPublicKeyCredential)]) {
    id<ASPublicKeyCredential> key = credential;
    result[@"id"] = key.credentialID;
    result[@"clientDataJSON"] = key.rawClientDataJSON;
  }
  if ([credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistration class]]) {
    ASAuthorizationPlatformPublicKeyCredentialRegistration *created = credential;
    BOOL here = created.attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform;
    result[@"attachment"] = here ? @"platform" : @"cross-platform";
    // A passkey Apple keeps can also be used from a phone; one made on a
    // phone stays there.
    result[@"transports"] = here ? @[ @"hybrid", @"internal" ] : @[ @"hybrid" ];
    if (created.rawAttestationObject) result[@"attestationObject"] = created.rawAttestationObject;
  } else if ([credential isKindOfClass:[ASAuthorizationSecurityKeyPublicKeyCredentialRegistration class]]) {
    ASAuthorizationSecurityKeyPublicKeyCredentialRegistration *created = credential;
    result[@"attachment"] = @"cross-platform";
    if (@available(macOS 14.5, *)) result[@"transports"] = transportNames(created.transports);
    if (created.rawAttestationObject) result[@"attestationObject"] = created.rawAttestationObject;
  } else if ([credential conformsToProtocol:@protocol(ASAuthorizationPublicKeyCredentialAssertion)]) {
    id<ASAuthorizationPublicKeyCredentialAssertion> used = credential;
    result[@"authenticatorData"] = used.rawAuthenticatorData;
    result[@"signature"] = used.signature;
    if (used.userID.length) result[@"userHandle"] = used.userID;
    BOOL here = [credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialAssertion class]] &&
      ((ASAuthorizationPlatformPublicKeyCredentialAssertion *)credential).attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform;
    result[@"attachment"] = here ? @"platform" : @"cross-platform";
  }
  BOOL complete = result[@"id"] && result[@"clientDataJSON"] && (result[@"attestationObject"] || result[@"signature"]);
  return complete ? result : nil;
}

@implementation LitPasskeyRequest

- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
  return self.window;
}

- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithAuthorization:(ASAuthorization *)authorization {
  NSDictionary *result = nil;
  // Requests are only made on macOS 14.4 or later (see Perform).
  if (@available(macOS 14.4, *)) result = resultOf(authorization.credential);
  finish(self, result ? @{ @"credential": result } : failure(LIT_NO_RESULT, @"The passkey sheet gave nothing to use."));
}

- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithError:(NSError *)error {
  finish(self, failure(error.code, error.localizedDescription));
}

@end

// --- Exports ---------------------------------------------------------------

static bool isAvailable(void) {
  if (@available(macOS 14.4, *)) {
    SecTaskRef task = SecTaskCreateFromSelf(NULL);
    if (!task) return false;
    CFTypeRef value = SecTaskCopyValueForEntitlement(task, (__bridge CFStringRef)ENTITLEMENT, NULL);
    CFRelease(task);
    bool granted = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(value);
    if (value) CFRelease(value);
    return granted;
  }
  return false;
}

static napi_value Available(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, isAvailable(), &result);
  return result;
}

// Answers `done` at once, as the sheet would.
static napi_value refuseNow(napi_env env, napi_value done, NSInteger code, NSString *message) {
  napi_value undefined, argument;
  napi_get_undefined(env, &undefined);
  argument = toJS(env, failure(code, message));
  napi_call_function(env, undefined, done, 1, &argument, NULL);
  return undefined;
}

static napi_value Perform(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3], undefined;
  napi_get_undefined(env, &undefined);
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_valuetype doneType = napi_undefined;
  if (argc == 3) napi_typeof(env, argv[2], &doneType);
  if (doneType != napi_function) {
    napi_throw_type_error(env, NULL, "perform(window, request, done)");
    return undefined;
  }
  napi_value done = argv[2];
  if (!isAvailable()) return refuseNow(env, done, ASAuthorizationErrorNotHandled, @"Lit isn't allowed to use passkeys.");
  if (current) return refuseNow(env, done, LIT_BUSY, @"Another passkey request is open.");

  void *handle = NULL;
  size_t length = 0;
  bool isBuffer = false;
  napi_is_buffer(env, argv[0], &isBuffer);
  if (isBuffer) napi_get_buffer_info(env, argv[0], &handle, &length);
  NSView *view = isBuffer && length == sizeof(void *) ? (__bridge NSView *)(*(void **)handle) : nil;
  NSWindow *window = view.window;
  if (!window) return refuseNow(env, done, LIT_NO_WINDOW, @"The page has no window.");

  NSArray<ASAuthorizationRequest *> *requests = nil;
  if (@available(macOS 14.4, *)) requests = requestsOf(env, argv[1]);
  if (!requests) return refuseNow(env, done, LIT_BAD_REQUEST, @"The request can't be shown.");

  LitPasskeyRequest *request = [LitPasskeyRequest new];
  request.window = window;
  napi_value name;
  napi_create_string_utf8(env, "passkey sheet", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function tsfn;
  if (napi_create_threadsafe_function(env, done, NULL, name, 0, 1, NULL, NULL, NULL, callDone, &tsfn) != napi_ok) {
    return refuseNow(env, done, LIT_BAD_REQUEST, @"The request can't be shown.");
  }
  request.done = tsfn;
  request.controller = [[ASAuthorizationController alloc] initWithAuthorizationRequests:requests];
  request.controller.delegate = request;
  request.controller.presentationContextProvider = request;
  current = request;
  [request.controller performRequests];
  return undefined;
}

static napi_value Cancel(napi_env env, napi_callback_info info) {
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  LitPasskeyRequest *request = current;
  if (!request) return undefined;
  if (@available(macOS 13.0, *)) [request.controller cancel];
  // Answered now, whether or not the sheet says so after.
  finish(request, failure(ASAuthorizationErrorCanceled, @"The request was cancelled."));
  return undefined;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor exports_[] = {
    { "available", NULL, Available, NULL, NULL, NULL, napi_enumerable, NULL },
    { "perform", NULL, Perform, NULL, NULL, NULL, napi_enumerable, NULL },
    { "cancel", NULL, Cancel, NULL, NULL, NULL, napi_enumerable, NULL },
  };
  napi_define_properties(env, exports, sizeof exports_ / sizeof *exports_, exports_);
  return exports;
}
