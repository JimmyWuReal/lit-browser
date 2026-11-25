const test = require('node:test')
const assert = require('node:assert/strict')
const { passwordOf, oldOf, signsIn, nameOf } = require('../src/page')

const field = (name, value = name, rest = {}) => ({ name, value, type: 'text', autocomplete: '', ...rest })
const secret = (value, autocomplete = '') => field('p', value, { type: 'password', autocomplete })
const yes = () => true

test('passwordOf takes the new password when one is being changed', () => {
  assert.equal(passwordOf([secret('a')]).value, 'a')
  assert.equal(passwordOf([secret('')]), null)
  assert.equal(passwordOf([secret('old'), secret('new'), secret('new')]).value, 'new')
  assert.equal(passwordOf([secret('new'), secret('new')]).value, 'new')
  assert.equal(passwordOf([secret('old'), secret('new')]).value, 'new')
  assert.equal(passwordOf([secret('old', 'current-password'), secret('new', 'new-password')]).value, 'new')
  // The same one kept as the new one.
  assert.equal(passwordOf([secret('a', 'current-password'), secret('a'), secret('a')]).value, 'a')
})

test('oldOf is the password typed before the new one', () => {
  const old = (...fields) => oldOf(fields, passwordOf(fields))
  assert.equal(old(secret('a')), '')
  assert.equal(old(secret('old'), secret('new')), 'old')
  assert.equal(old(secret('old'), secret('new'), secret('new')), 'old')
  assert.equal(old(secret('new'), secret('new')), '')
  assert.equal(old(secret('old', 'current-password'), secret('new', 'new-password')), 'old')
  assert.equal(old(secret('a', 'new-password'), secret('a', 'new-password')), '')
})

test('signsIn tells buttons that sign in', () => {
  for (const text of ['Sign in', 'Log In', 'Continue', 'Change password', '登入']) assert.equal(signsIn(text), true, text)
  for (const text of ['', 'Cancel', 'Show password', 'Continue with Google', 'Forgot password?', 'Menu']) assert.equal(signsIn(text), false, text)
})

test('nameOf prefers the marked field, then the last one before the password', () => {
  const password = secret('a')
  const email = field('email', 'e', { type: 'email' })
  const marked = field('user', 'u', { autocomplete: 'section-a username' })
  assert.equal(nameOf([field('search'), email, password, field('after')], password, yes), email)
  assert.equal(nameOf([email, marked, password], password, yes), marked)
  assert.equal(nameOf([field('code', '1', { autocomplete: 'one-time-code' }), password], password, yes), null)
  assert.equal(nameOf([password], password, yes), null)
  // Hidden, only a marked one counts.
  assert.equal(nameOf([email, password], password, () => false), null)
  assert.equal(nameOf([marked, password], password, () => false), marked)
})
