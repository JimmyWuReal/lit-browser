// Find in page: the state each tab keeps for its find field, as plain data
// so it is tested in test/find.test.js. A tab's find is null while its find
// field is closed, otherwise:
//   text       what is typed in the field
//   active     which match is selected, from 1 (0 before the first result)
//   matches    how many matches the page has, or null until Chromium answers
//   requestId  the latest findInPage request, or null when the next search
//              must start a new one (new text, or a new page)

// The longest text a search takes; the toolbar's field has the same maxlength.
const MAX_TEXT = 1000

// Opening keeps a field that is already open; a closed one reopens with
// the tab's last search, as in other browsers.
const open = (find, lastText = '') => find ?? { text: lastText, active: 0, matches: null, requestId: null }

// New text clears the old counts until the page answers for it.
const setText = (find, text) => ({ ...find, text, active: 0, matches: null, requestId: null })

// A navigation leaves the field open with its text, but the old page's
// matches are gone, so the next search starts over.
const reset = (find) => (find ? { ...find, active: 0, matches: null, requestId: null } : find)

// Chromium's found-in-page result. Answers to older requests (still arriving
// after newer text was typed) are dropped, so the count never goes back.
function result(find, { requestId, activeMatchOrdinal, matches }) {
  if (!find || requestId !== find.requestId) return find
  return {
    ...find,
    active: activeMatchOrdinal ?? find.active,
    matches: matches ?? find.matches,
  }
}

module.exports = { MAX_TEXT, open, setText, reset, result }
