// Runs in every web page's top frame, in a world apart from the page's own
// scripts, for saved passwords. It tells main when someone signs in and when
// they ask for passwords in a login field, and fills the one they pick. It
// knows no saved password until then. Frames inside a page get none of this.
// Sandboxed, so it can require nothing but electron. The choice of fields is
// plain (no DOM), so it is tested in test/page.test.js.

const tokens = (field) => (field.autocomplete || '').toLowerCase().split(/\s+/)
const has = (field, token) => tokens(field).includes(token)
const isNew = (field) => has(field, 'new-password')
// A login's name can be typed into these.
const NAME_TYPES = ['text', 'email', 'tel', 'url', 'search', 'number']
// Marked by the site as a login's name.
const isName = (field) => has(field, 'username')

// The password to save out of a form's filled password fields, in order: the
// new one when it is being changed (marked so, or typed twice, or the second
// of old and new), else the one there is.
function passwordOf(fields) {
  const filled = fields.filter((field) => field.value)
  const fresh = filled.find(isNew)
  if (fresh || filled.length < 2) return fresh || filled[0] || null
  if (has(filled[0], 'current-password')) return filled[1]
  return filled.find((field, i) => filled.slice(i + 1).some((other) => other.value === field.value)) || filled[1]
}

// The username field among a form's fields, in order: the one marked so, else
// the last name-like one before the password. `visible` says which can be seen;
// a hidden one counts only when marked (a second step repeats the name there).
function nameOf(fields, password, visible) {
  const marked = fields.filter(isName)
  const shown = marked.find(visible) || marked[0]
  if (shown) return shown
  const before = fields.slice(0, Math.max(fields.indexOf(password), 0)).filter((field) => NAME_TYPES.includes(field.type) && visible(field))
  return before.findLast((field) => !has(field, 'one-time-code')) || null
}

function start({ ipcRenderer }) {
  const visible = (field) => field.isConnected && field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && field.getClientRects().length > 0
  const isField = (target) => target instanceof HTMLInputElement && !target.disabled && !target.readOnly
  // What a field goes with: its form, else everything in its document (or
  // shadow tree).
  const fieldsWith = (element) => [...(element.form?.elements ?? element.getRootNode().querySelectorAll('input'))].filter((each) => each instanceof HTMLInputElement)
  const passwords = (fields) => fields.filter((field) => field.type === 'password' && visible(field))

  // Someone signed in with these fields, as far as can be told. Main asks to
  // save it once the sign-in seems to have worked: another page comes, or, in
  // a page that stays, its password field goes away for good.
  let watch = null
  function submitted(fields) {
    const password = passwordOf(passwords(fields))
    if (!password) return
    const name = nameOf(fields, password, visible)
    ipcRenderer.send('login-submitted', { username: (name?.value || '').trim(), password: password.value })
    clearInterval(watch)
    let gone = 0
    let left = 60
    watch = setInterval(() => {
      gone = visible(password) ? 0 : gone + 1
      if (gone < 3 && --left > 0) return
      clearInterval(watch)
      if (gone >= 3) ipcRenderer.send('login-done')
    }, 500)
  }
  addEventListener('submit', (event) => {
    if (event.isTrusted && event.target instanceof HTMLFormElement) submitted([...event.target.elements].filter((each) => each instanceof HTMLInputElement))
  }, true)
  // Pages without a form, or with a button that isn't a submit one.
  addEventListener('keydown', (event) => {
    const field = event.composedPath()[0]
    if (event.isTrusted && event.key === 'Enter' && !event.isComposing && isField(field) && field.type === 'password') submitted(fieldsWith(field))
  }, true)
  addEventListener('click', (event) => {
    if (!event.isTrusted) return
    const button = event.composedPath().find((each) => each instanceof Element && each.matches('button, input[type=submit], input[type=button], [role=button]'))
    // Other buttons in a form (showing the password, say) don't sign in.
    if (button && (button.type === 'submit' || !button.closest('form'))) submitted(fieldsWith(button))
  }, true)

  // A field saved logins go in, when there is one for `target`:
  // { name, password }, either null.
  function loginAt(target) {
    if (!isField(target) || !visible(target) || isNew(target)) return null
    const fields = fieldsWith(target)
    const password = target.type === 'password' ? target : passwords(fields).find((field) => !isNew(field)) || null
    // A form that only makes a new password is for signing up.
    if (!password && fields.some((field) => field.type === 'password' && isNew(field))) return null
    const name = nameOf(fields, password, visible)
    const usable = name && isField(name) && visible(name) ? name : null
    if (target === password || (target === usable && (password || isName(target)))) return { name: usable, password }
    return null
  }

  // Passwords are offered when someone clicks a login field, tabs into it or
  // presses ↓ in it; never because the page moved focus there.
  // Main answers with login-fill, naming this `request`.
  let request = 0
  let asked = null
  let anchor = null
  function ask(target) {
    const login = loginAt(target)
    if (!login) return dismiss()
    asked = login
    anchor = target
    const { left, bottom, width } = target.getBoundingClientRect()
    ipcRenderer.send('login-field', { request: ++request, x: left, y: bottom, width, needsPassword: Boolean(login.password) })
  }
  function dismiss() {
    if (!anchor) return
    anchor = null
    ipcRenderer.send('login-field-left')
  }
  addEventListener('click', (event) => { if (event.isTrusted && event.composedPath()[0] instanceof HTMLInputElement) ask(event.composedPath()[0]) }, true)
  addEventListener('keyup', (event) => { if (event.isTrusted && event.key === 'Tab') ask(event.composedPath()[0]) }, true)
  addEventListener('keydown', (event) => {
    if (event.isTrusted && event.key === 'ArrowDown' && !anchor && !event.isComposing) ask(event.composedPath()[0])
  }, true)
  // Anything that moves the field away, or leaves it, or types in it.
  addEventListener('focusout', dismiss, true)
  addEventListener('input', dismiss, true)
  addEventListener('scroll', dismiss, true)
  addEventListener('resize', dismiss)

  function type(field, value) {
    field.focus()
    // This world's own setter, so frameworks that watch theirs see a change.
    field.value = value
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }
  ipcRenderer.on('login-fill', (_event, login) => {
    if (login.request !== request || login.site !== location.origin || !asked) return
    const { name, password } = asked
    asked = null
    dismiss()
    if (name && visible(name) && login.username) type(name, login.username)
    if (password && visible(password) && login.password !== null) type(password, login.password)
  })
}

if (typeof window !== 'undefined') {
  if (/^https?:$/.test(location.protocol)) start(require('electron'))
} else module.exports = { passwordOf, nameOf }
