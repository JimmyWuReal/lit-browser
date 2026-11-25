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

// The password being replaced, typed before the new one (`password`, as
// passwordOf picks it), or ''.
function oldOf(fields, password) {
  const filled = fields.filter((field) => field.value)
  return filled.slice(0, filled.indexOf(password)).findLast((field) => !isNew(field))?.value || ''
}

// Whether a button's words say it signs in, signs up or changes a password.
// Only asked when the page sends no submit, so one in a language not here still
// saves from a real form, or with Enter.
const signsIn = (text) => /\b(sign[\s-]?(in|up|on)|log[\s-]?(in|on)|login|submit|continue|next|go|enter|unlock|register|join|create account|(save|change|update|set|reset) (my )?(password|changes)|save|update|confirm)\b|登入|登錄|登录|注册|註冊|下一步|繼續|继续|送出|提交|確認|确认|ログイン|로그인/i.test(text) &&
  !/\b(cancel|close|forgot|show|hide|with|guest|without)\b/i.test(text)

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
  // Every input in the page, in open shadow trees too.
  const inputsIn = (root) => [...root.querySelectorAll('*')].flatMap((each) => [...(each instanceof HTMLInputElement ? [each] : []), ...(each.shadowRoot ? inputsIn(each.shadowRoot) : [])])
  const passwords = (fields) => fields.filter((field) => field.type === 'password' && visible(field))

  // The name field of a form without a password: the first step of two.
  function nameAlone(fields) {
    const emails = fields.filter((field) => field.type === 'email' && visible(field))
    return nameOf(fields, null, visible) || (emails.length === 1 ? emails[0] : null)
  }

  // Someone signed in with these fields, as far as can be told. Main asks to
  // save it once the sign-in seems to have worked: another page comes, or, in
  // a page that stays, its password field goes away for good.
  let watch = null
  // A name was sent, for a password that may come later.
  let named = false
  // With `maybe`, taken back if the password is no longer one a moment after:
  // a button that shows it has made it text by then. Said at once all the same,
  // as signing in may leave the page before that.
  function submitted(fields, maybe = false) {
    const filled = passwords(fields).some((field) => field.value) || nameAlone(fields)?.value
    // Nothing typed leaves the page unless it may be saved. Asked each time,
    // as Settings can change it, and now, as the page may be about to go.
    if (!filled || !ipcRenderer.sendSync('login-saves')) return
    const password = passwordOf(passwords(fields))
    if (!password) {
      // The second step may not repeat it.
      const name = nameAlone(fields)
      if (name?.value) {
        named = true
        ipcRenderer.send('login-name', { username: name.value.trim() })
      }
      return
    }
    const name = nameOf(fields, password, visible)
    const login = { username: (name?.value || '').trim(), password: password.value, old: oldOf(passwords(fields), password) }
    begin(password, login)
    if (maybe) {
      const mine = watch
      setTimeout(() => { if (watch === mine && password.type !== 'password') abandon() }, 50)
    }
  }
  function begin(password, login) {
    ipcRenderer.send('login-submitted', login)
    clearInterval(watch)
    let gone = 0
    let left = 60
    watch = setInterval(() => {
      // Another password field in its place is the form, drawn again.
      gone = visible(password) || passwords(inputsIn(document)).length ? 0 : gone + 1
      // Refused, by the page's own word, or never heard of again.
      if (!gone && (password.matches('[aria-invalid=true]') || --left <= 0)) return abandon()
      if (gone < 3) return
      clearInterval(watch)
      watch = null
      ipcRenderer.send('login-done')
    }, 500)
  }
  // Typing again, following a link or pressing another button, after a sign-in
  // that led nowhere.
  function abandon() {
    if (watch === null) return
    clearInterval(watch)
    watch = null
    ipcRenderer.send('login-abandoned')
  }
  addEventListener('input', (event) => {
    if (event.isTrusted && event.composedPath()[0] instanceof HTMLInputElement) abandon()
  }, true)
  addEventListener('submit', (event) => {
    if (event.isTrusted && event.target instanceof HTMLFormElement) submitted([...event.target.elements].filter((each) => each instanceof HTMLInputElement))
  }, true)
  // Pages without a form, or that sign in without submitting theirs. A form
  // Chromium refuses to submit (a field left empty) signs no one in.
  const allowed = ({ form }) => !form || form.noValidate || form.matches(':valid')
  addEventListener('keydown', (event) => {
    const field = event.composedPath()[0]
    if (event.isTrusted && event.key === 'Enter' && !event.isComposing && isField(field) && ['password', 'email', 'text'].includes(field.type) && allowed(field)) submitted(fieldsWith(field))
  }, true)
  addEventListener('click', (event) => {
    if (!event.isTrusted) return
    if (event.composedPath().some((each) => each instanceof Element && each.matches('a[href]:not([href^="#"])'))) {
      if (named && watch === null) ipcRenderer.send('login-abandoned')
      named = false
      return abandon()
    }
    const button = event.composedPath().find((each) => each instanceof Element && each.matches('button, input[type=submit], input[type=button], [role=button]'))
    if (!button) return
    if (button.type === 'reset' || button.formMethod === 'dialog' || button.form?.method === 'dialog') return abandon()
    if (!signsIn([button.textContent, button.value, button.getAttribute('aria-label'), button.title].join(' '))) return abandon()
    const form = button.closest('form')
    if (button.type === 'submit') {
      if (allowed(button)) submitted(fieldsWith(button))
    } else submitted(form ? [...form.elements].filter((each) => each instanceof HTMLInputElement) : fieldsWith(button), true)
  }, true)

  // A field saved logins go in, when there is one for `target`:
  // { name, password }, either null.
  function loginAt(target) {
    if (!isField(target) || !visible(target) || isNew(target)) return null
    const fields = fieldsWith(target)
    const password = target.type === 'password' ? target : passwords(fields).find((field) => isField(field) && !isNew(field)) || null
    // A form that only makes a new password is for signing up.
    if (!password && fields.some((field) => field.type === 'password' && isNew(field))) return null
    const name = password ? nameOf(fields, password, visible) : nameAlone(fields)
    const usable = name && isField(name) && visible(name) ? name : null
    if (target === password || target === usable) return { name: usable, password }
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
    asked = { ...login, target }
    anchor = target
    const { left, top, bottom, width } = target.getBoundingClientRect()
    ipcRenderer.send('login-field', { request: ++request, x: left, top, y: bottom, width, needsPassword: Boolean(login.password) })
  }
  function dismiss() {
    if (!anchor) return
    anchor = null
    ipcRenderer.send('login-field-left')
  }
  addEventListener('click', (event) => { if (event.isTrusted && event.composedPath()[0] instanceof HTMLInputElement) ask(event.composedPath()[0]) }, true)
  addEventListener('keyup', (event) => { if (event.isTrusted && event.key === 'Tab') ask(event.composedPath()[0]) }, true)
  addEventListener('keydown', (event) => {
    // With the list open, main takes the key.
    if (event.isTrusted && event.key === 'ArrowDown' && !event.isComposing) ask(event.composedPath()[0])
  }, true)
  // Anything that moves the field away, or leaves it, or types in it.
  addEventListener('focusout', dismiss, true)
  addEventListener('input', dismiss, true)
  addEventListener('scroll', dismiss, true)
  addEventListener('resize', dismiss)

  function type(field, value) {
    // This world's own setter, so frameworks that watch theirs see a change.
    field.value = value
    field.focus()
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }
  ipcRenderer.on('login-fill', (_event, login) => {
    if (login.request !== request || login.site !== location.origin || !asked) return
    const { name, password, target } = asked
    // The page may have changed its fields since, or do so as the name is
    // filled: a password goes only where one would be offered now.
    const still = (field, kind) => field && loginAt(target)?.[kind] === field
    asked = null
    dismiss()
    if (still(name, 'name') && login.username) type(name, login.username)
    if (login.password !== null && still(password, 'password') && isField(password) && password.type === 'password') type(password, login.password)
  })
}

if (typeof window !== 'undefined') {
  if (/^https?:$/.test(location.protocol)) start(require('electron'))
} else module.exports = { passwordOf, oldOf, signsIn, nameOf }
