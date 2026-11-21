import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { readPageEvidence, type PageEvidence } from '../src/web-browser/dom.ts'
import { accountBindingForVisibleIdentity } from '../src/web-browser/index.ts'

interface TextFixture { text: string, hidden?: boolean, message?: boolean }

/** Execute the production reader with DOM text-node boundaries. No browser run is claimed. */
function accountEvidence(values: TextFixture[]): PageEvidence {
  const parent = (value?: TextFixture) => ({
    getClientRects: () => value?.hidden ? [] : [{}],
    closest: (selector: string) => value?.hidden && selector.includes('[hidden]') || value?.message && selector.includes('[data-message-author-role]') ? {} : null,
  })
  const menu = { ...parent(),
    innerText: values.filter(value => !value.hidden).map(value => value.text).join(''),
    matches: (selector: string) => selector.includes('[data-testid="account-menu"]'),
    querySelectorAll: () => [],
  }
  const document = {
    querySelectorAll: (selector: string) => selector === '[role="menu"],[role="dialog"],[data-radix-menu-content]' ? [menu] : [],
    createTreeWalker(root: unknown, whatToShow: number) {
      assert.equal(root, menu)
      assert.equal(whatToShow, 4)
      const nodes = values.map(value => ({ textContent: value.text, parentElement: parent(value) }))
      let index = 0
      return { nextNode: () => nodes[index++] ?? null }
    },
  }
  const result = new Script(`(${readPageEvidence.toString()})()`).runInNewContext({ document, location: { href: 'http://127.0.0.1:1234/' },
    NodeFilter: { SHOW_TEXT: 4 }, HTMLTextAreaElement: class {} }) as PageEvidence
  return { ...result, accountIdentities: [...result.accountIdentities] }
}

test('visible account email does not absorb a directly adjacent account-menu action label', () => {
  const evidence = accountEvidence([{ text: 'owner@example.test' }, { text: 'Log out' }])
  assert.deepEqual(evidence.accountIdentities, ['owner@example.test'])
  assert.equal(accountBindingForVisibleIdentity(evidence.accountIdentities[0]!), 'sha256:beef9398257cf76dc168d7d2997edd3eb4aacca3942f24f969b7a702847c268c')
})

test('account evidence retains both distinct visible emails for the caller to reject as ambiguous', () => {
  assert.deepEqual(accountEvidence([{ text: 'owner@example.test' }, { text: 'another@example.test' }, { text: 'Log out' }]).accountIdentities,
    ['owner@example.test', 'another@example.test'])
})

test('hidden and conversation text cannot become the visible account binding', () => {
  assert.deepEqual(accountEvidence([{ text: 'owner@example.test' }, { text: 'hidden@example.test', hidden: true },
    { text: 'message@example.test', message: true }, { text: 'Sign out' }]).accountIdentities, ['owner@example.test'])
})

test('account reader does not invent a cross-element email or accept action text as a domain suffix', () => {
  assert.deepEqual(accountEvidence([{ text: 'owner@' }, { text: 'example.test' }, { text: 'Log out' }]).accountIdentities, [])
})
