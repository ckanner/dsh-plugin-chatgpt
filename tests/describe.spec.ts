import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describableModels, describeModel } from '../src/models/describe.ts'

describe('describeModel', () => {
  it('fills capacities and reasoning levels from the catalog', () => {
    const model = describeModel({ slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' })

    assert.equal(model.id, 'gpt-6.1-sol')
    assert.equal(model.name, 'GPT-6.1 Sol')
    assert.equal(model.metadataSource, 'catalog')
    assert.ok(model.contextWindow >= 200000)
    assert.ok((model.maxTokens ?? 0) > 0)
    assert.deepEqual(model.input, ['text', 'image'])
    // Every effort the model accepts is offered, in escalation order.
    assert.deepEqual(model.reasoningEfforts?.map(effort => effort.id), [
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
    assert.deepEqual(model.reasoningEfforts?.[0], { id: 'low', name: 'Low' })
    assert.equal(model.defaultReasoningEffort, 'medium')
  })

  it('omits the efforts a model maps to null', () => {
    // o3 accepts low/medium/high but not xhigh or max; offering those would
    // produce requests the model rejects.
    const model = describeModel({ slug: 'o3' })

    assert.equal(model.metadataSource, 'catalog')
    assert.deepEqual(model.reasoningEfforts?.map(effort => effort.id), ['low', 'medium', 'high'])
    assert.equal(model.defaultReasoningEffort, 'medium')
  })

  it('reports a model the catalog does not describe as a fallback, not as absent', () => {
    const model = describeModel({ slug: 'gpt-9-unknown' })

    // Still callable, still selectable — just honestly labelled as undescribed.
    assert.equal(model.id, 'gpt-9-unknown')
    assert.equal(model.name, 'gpt-9-unknown')
    assert.equal(model.metadataSource, 'fallback')
    assert.ok(model.contextWindow > 0)
    assert.equal(model.reasoningEfforts, undefined)
  })

  it('prefers the account\'s display name over the catalog name', () => {
    assert.equal(describeModel({ slug: 'gpt-6.1-sol', displayName: 'Sol (work)' }).name, 'Sol (work)')
  })

  it('falls back to the catalog name when the listing names nothing', () => {
    const model = describeModel({ slug: 'gpt-6.1-sol' })

    assert.equal(model.name, 'GPT-6.1 Sol')
  })

  it('gives a non-reasoning model no selectable efforts', () => {
    const model = describeModel({ slug: 'gpt-4.1' })

    assert.equal(model.reasoningEfforts, undefined)
    assert.equal(model.defaultReasoningEffort, undefined)
  })
})

describe('describableModels', () => {
  it('keeps only the entries meant for display, in the server\'s order', () => {
    const models = describableModels([
      { slug: 'gpt-6.1-sol', visibility: 'list' },
      { slug: 'hidden-a', visibility: 'hide' },
      { slug: 'gpt-6-astra', visibility: 'list' },
      { slug: 'hidden-b', visibility: 'hidden' },
    ])

    // The order is the server's ranking, so it is preserved rather than sorted.
    assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-astra'])
  })

  it('keeps an entry that declares no visibility, since only an explicit hide excludes one', () => {
    assert.deepEqual(describableModels([{ slug: 'gpt-6.1-sol' }]).map(m => m.id), ['gpt-6.1-sol'])
  })

  it('drops an entry with no slug rather than offering an uncallable model', () => {
    assert.deepEqual(describableModels([{ slug: '' }, { slug: 'gpt-6.1-sol' }]).map(m => m.id), ['gpt-6.1-sol'])
  })

  it('describes every model it returns, naming where the description came from', () => {
    const models = describableModels([{ slug: 'gpt-6.1-sol' }, { slug: 'never-heard-of-it' }])

    assert.deepEqual(models.map(model => model.metadataSource), ['catalog', 'fallback'])
  })

  it('prefers the endpoint\'s own description over the bundled catalog', () => {
    // The endpoint describes the models it lists — capacities, reasoning levels,
    // and modalities all arrive with the listing. A stale snapshot must not
    // override the live description of a model this account is entitled to.
    const model = describeModel({
      slug: 'gpt-6.1-sol',
      displayName: 'From the endpoint',
      contextWindow: 400000,
      maxContextWindow: 900000,
      inputModalities: ['text'],
      defaultReasoningLevel: 'high',
      reasoningLevels: [
        { effort: 'high', description: 'Deep' },
        { effort: 'low', description: 'Quick' },
      ],
      description: 'Frontier model.',
    })

    assert.equal(model.metadataSource, 'endpoint')
    assert.equal(model.name, 'From the endpoint')
    assert.equal(model.contextWindow, 400000)
    assert.equal(model.maxContextWindow, 900000)
    assert.equal(model.description, 'Frontier model.')
    assert.deepEqual(model.input, ['text'])
    // The endpoint's order is not trusted for display: efforts are offered in
    // escalation order, and its per-level text is kept.
    assert.deepEqual(model.reasoningEfforts, [
      { id: 'low', name: 'Low', description: 'Quick' },
      { id: 'high', name: 'High', description: 'Deep' },
    ])
    assert.equal(model.defaultReasoningEffort, 'high')
  })

  it('falls back to the catalog for a model the endpoint did not describe', () => {
    // A listing that carries only the slug is still answerable: the catalog
    // describes the model, which is the reason it is bundled.
    const model = describeModel({ slug: 'gpt-6.1-sol' })

    assert.equal(model.metadataSource, 'catalog')
    assert.ok(model.contextWindow >= 200000)
    assert.ok((model.reasoningEfforts ?? []).length > 0)
  })

  it('ignores an endpoint default effort the model does not accept', () => {
    const model = describeModel({
      slug: 'x',
      contextWindow: 1000,
      defaultReasoningLevel: 'ultra',
      reasoningLevels: [{ effort: 'low' }, { effort: 'high' }],
    })

    // Never offer a default the level list contradicts.
    assert.equal(model.defaultReasoningEffort, 'high')
  })

  it('offers a new effort spelling the bundled catalog has never seen', () => {
    const model = describeModel({
      slug: 'future-model',
      contextWindow: 1000,
      reasoningLevels: [{ effort: 'ultra', description: 'Deepest' }],
    })

    assert.deepEqual(model.reasoningEfforts, [{ id: 'ultra', name: 'Ultra', description: 'Deepest' }])
    assert.equal(model.metadataSource, 'endpoint')
  })
})
