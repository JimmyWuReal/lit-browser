const test = require('node:test')
const assert = require('node:assert/strict')
const { describe } = require('../src/errors')

const load = (name, url = 'https://example.com/a') => describe({ kind: 'load', name }, url)

test('says what went wrong, naming the site and the code', () => {
  assert.deepEqual(load('ERR_NAME_NOT_RESOLVED'), {
    title: 'This site can’t be reached',
    detail: 'The server for example.com couldn’t be found. Check the address for typos.',
    code: 'ERR_NAME_NOT_RESOLVED',
  })
  assert.match(load('ERR_CONNECTION_REFUSED', 'http://localhost:5173/').detail, /^localhost:5173 refused/)
  assert.equal(load('ERR_INTERNET_DISCONNECTED').title, 'You’re offline')
})

test('tells similar failures apart', () => {
  const titles = (...names) => names.map((name) => load(name).title)
  assert.deepEqual(titles('ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_SSL_PROTOCOL_ERROR'),
    ['This connection isn’t private', 'This connection isn’t private', 'Can’t connect securely'])
  assert.match(load('ERR_CERT_DATE_INVALID').detail, /expired/)
  assert.match(load('ERR_CERT_AUTHORITY_INVALID').detail, /doesn’t trust/)
  assert.match(load('ERR_TIMED_OUT').detail, /too long/)
  assert.match(load('ERR_CONNECTION_TIMED_OUT').detail, /too long/)
  assert.equal(load('ERR_PROXY_CONNECTION_FAILED').title, 'Can’t connect to the proxy')
})

test('an unknown failure, and an address without a site, still read well', () => {
  assert.deepEqual(load('ERR_SOMETHING_NEW'), { title: 'This page can’t be opened', detail: 'Something went wrong while loading it.', code: 'ERR_SOMETHING_NEW' })
  assert.equal(load('ERR_CONNECTION_RESET', 'not a url').detail, 'The connection to this address was interrupted.')
  assert.equal(load('ERR_FILE_NOT_FOUND', 'file:///nope').title, 'This file can’t be found')
})

test('HTTP errors have their status', () => {
  const http = (status) => describe({ kind: 'http', status }, 'https://example.com/')
  assert.deepEqual(http(404), { title: 'This page can’t be found', detail: 'example.com has nothing at this address.', code: 'HTTP 404' })
  assert.equal(http(503).detail, 'example.com has a problem of its own.')
  assert.equal(http(418).detail, 'example.com couldn’t answer this request.')
})

test('crashes tell running out of memory apart', () => {
  const crash = (reason) => describe({ kind: 'crash', reason, exitCode: 5 }, 'https://example.com/')
  assert.equal(crash('crashed').title, 'This page crashed')
  assert.equal(crash('crashed').code, 'crashed (5)')
  assert.equal(crash('oom').title, 'This page ran out of memory')
})
