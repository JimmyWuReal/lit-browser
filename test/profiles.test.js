const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DEFAULT, COLORS, folder, partition, add, update, remove, clean, load, save, sweep } = require('../src/profiles')

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lit-profiles-'))
const first = clean()

test('there is always a default profile, first, in the places from before profiles', () => {
  assert.deepEqual(first, { profiles: [{ id: DEFAULT, name: 'Personal', color: 'gray' }], last: DEFAULT, removed: [] })
  assert.equal(folder('/data', DEFAULT), '/data')
  assert.equal(partition(DEFAULT), undefined)
  const { state, profile } = add(first)
  const moved = clean({ profiles: [...state.profiles].reverse() })
  assert.deepEqual(moved.profiles.map(({ id }) => id), [DEFAULT, profile.id])
})

test('a new profile gets its own name, color, folder and session', () => {
  const one = add(first)
  const two = add(one.state)
  assert.deepEqual(two.state.profiles.map(({ name }) => name), ['Personal', 'Profile 2', 'Profile 3'])
  assert.equal(new Set(two.state.profiles.map(({ color }) => color)).size, 3)
  assert.equal(folder('/data', one.profile.id), path.join('/data', 'Profiles', one.profile.id))
  assert.equal(partition(one.profile.id), `persist:profile-${one.profile.id}`)
  // The number skips a name in use.
  const renamed = update(first, DEFAULT, { name: 'profile 2' }).state
  assert.equal(add(renamed).profile.name, 'Profile 3')
})

test('update renames and recolors, refusing what cannot be', () => {
  const { state, profile } = add(first)
  const { state: next, error } = update(state, profile.id, { name: '  Work ', color: 'pink' })
  assert.equal(error, undefined)
  assert.deepEqual(next.profiles[1], { id: profile.id, name: 'Work', color: 'pink' })
  for (const changes of [{ name: ' ' }, { name: 'x'.repeat(41) }, { name: 'personal' }, { color: 'beige' }]) {
    const refused = update(next, profile.id, changes)
    assert.ok(refused.error)
    assert.equal(refused.state, next)
  }
  assert.equal(update(next, profile.id, { name: 'WORK' }).error, undefined)
  assert.ok(update(next, 'gone', { name: 'A' }).error)
})

test('remove takes a profile off the list, but never the default one', () => {
  const { state, profile } = add(first)
  const removed = remove({ ...state, last: profile.id }, profile.id)
  assert.deepEqual(removed, { ...first, removed: [profile.id] })
  assert.equal(remove(first, DEFAULT), first)
  assert.equal(remove(first, profile.id), first)
})

test('clean keeps only well-formed profiles', () => {
  const { profile } = add(first)
  const state = clean({
    profiles: [null, { id: '../../etc', name: 'Bad' }, { ...profile, name: '', color: 'beige' }, profile, { id: DEFAULT, name: 'Me', color: 'blue' }],
    last: 'gone',
    removed: ['../..', profile.id, DEFAULT, 7],
  })
  assert.deepEqual(state.profiles.map(({ id }) => id), [DEFAULT, profile.id])
  assert.equal(state.profiles[0].name, 'Me')
  assert.equal(state.profiles[1].color, COLORS[0].id)
  assert.ok(state.profiles[1].name)
  assert.equal(state.last, DEFAULT)
  // A profile in use is never deleted, nor anything that is not a profile.
  assert.deepEqual(state.removed, [])
})

test('the list survives saving; a broken file is kept aside', () => {
  const file = path.join(temp(), 'profiles.json')
  assert.deepEqual(load(file), first)
  const { state } = add(first)
  save(file, state)
  assert.deepEqual(load(file), state)
  fs.writeFileSync(file, '{ broken')
  assert.deepEqual(load(file), first)
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{ broken')
})

test('sweep deletes only removed profiles', () => {
  const root = temp()
  const kept = add(first)
  const gone = add(kept.state)
  const places = ({ id }) => [folder(root, id), path.join(root, 'Partitions', `profile-${id}`)]
  for (const place of [...places(kept.profile), ...places(gone.profile)]) fs.mkdirSync(path.join(place, 'deep'), { recursive: true })
  const state = remove(gone.state, gone.profile.id)
  assert.deepEqual(sweep(root, state), kept.state)
  assert.ok(places(gone.profile).every((place) => !fs.existsSync(place)))
  assert.ok(places(kept.profile).every((place) => fs.existsSync(place)))
  assert.equal(sweep(root, kept.state), kept.state)
})
