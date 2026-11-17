import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProviderRouter } from '../src/ai/providers.js';
import { MetadataGenerator } from '../src/ai/metadataGenerator.js';

const SAMPLE_VIDEO = {
  id: 'vid_potato_tomato',
  fileName: 'potato-vs-tomato.mp4',
  filePath: 'C:/Users/example/WhiteboardFilms/films/potato-vs-tomato/out/potato-vs-tomato.mp4',
  durationSec: 42,
  width: 1080,
  height: 1920,
  aspectRatio: '9:16',
  sourceWorkflow: 'whiteboard-explainer',
  projectDir: 'C:/Users/example/WhiteboardFilms/films/potato-vs-tomato',
  analysis: {
    keyframes: [],
    projectContext: {
      titleHint: 'Potato vs Tomato',
      languageHint: 'en',
      scriptText:
        'Put a potato and a tomato on your counter. They belong to the exact same plant family and can even graft onto one stem. The potato stores starch underground, while the tomato grows bright fruit to attract birds.',
    },
  },
};

test('AI metadata generator sanitizes spam hashtags, adapts per platform, and respects grounded rules', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  contentSummary: 'Explains how potatoes and tomatoes share the Solanaceae plant family.',
                  detectedLanguage: 'en',
                  detectedTone: 'educational',
                  youtube: {
                    title: 'Why Potatoes and Tomatoes Are Actually Cousins',
                    description: 'Learn how potatoes and tomatoes share one plant blueprint yet use opposite survival strategies.',
                    hashtags: ['#botany', '#fyp', '#viral', '#plants', '#gardening'],
                    tags: ['potato vs tomato', 'plant biology', 'fyp', 'grafting'],
                    categoryId: '28',
                    pinnedComment: 'Have you ever seen a grafted pomato plant?',
                  },
                  instagram: {
                    caption: 'Same plant family, completely opposite bets. One hides starch underground, one shines in plain sight!',
                    hashtags: ['#plants', '#trending', '#explorepage', '#botanyfacts', '#science'],
                    callToAction: 'Save this for your next trivia night!',
                    emojis: ['🥔', '🍅'],
                  },
                }),
              },
            ],
          },
        },
      ],
    }),
  });

  const router = new AIProviderRouter({ fetchImpl: mockFetch });
  const generator = new MetadataGenerator({ aiProviderRouter: router });

  const result = await generator.generate({
    video: SAMPLE_VIDEO,
    aiConfig: { provider: 'gemini', geminiApiKey: 'test-key-123456', geminiModel: 'gemini-2.5-flash' },
    accountHints: ['youtube:Science Channel', 'instagram:@sciencefacts'],
  });

  assert.equal(result.providerUsed, 'gemini:gemini-2.5-flash');
  assert.equal(result.youtube.categoryId, '28');
  assert.equal(result.youtube.isShort, true);
  assert.notEqual(result.youtube.description, result.instagram.caption);

  // Spam tags stripped cleanly
  assert.equal(result.youtube.hashtags.includes('#fyp'), false);
  assert.equal(result.youtube.hashtags.includes('#viral'), false);
  assert.equal(result.youtube.tags.includes('fyp'), false);
  assert.equal(result.instagram.hashtags.includes('#trending'), false);
  assert.equal(result.instagram.hashtags.includes('#explorepage'), false);
  assert.ok(result.instagram.caption.includes('#botanyfacts'));
});

test('Deterministic grounded fallback produces platform-specific metadata when no AI API key is active', async () => {
  const router = new AIProviderRouter();
  const generator = new MetadataGenerator({ aiProviderRouter: router });

  const result = await generator.generate({
    video: SAMPLE_VIDEO,
    aiConfig: { provider: 'deterministic' },
    accountHints: ['youtube:Education', 'instagram:@explainers'],
  });

  assert.equal(result.providerUsed, 'deterministic:grounded');
  assert.ok(result.youtube.title.includes('Potato Vs Tomato'));
  assert.ok(result.youtube.description.includes('plant family'));
  assert.ok(result.youtube.hashtags.includes('#Shorts'));
  assert.ok(result.instagram.caption.includes('What surprised you most here'));
  assert.notEqual(result.youtube.description, result.instagram.caption);
});

test('Antigravity-authored metadata bypasses external AI calls, sets providerUsed=antigravity:agent, strips spam, and attaches extras cleanly', async () => {
  let externalAiCalled = false;
  const router = new AIProviderRouter({
    fetchImpl: async () => {
      externalAiCalled = true;
      throw new Error('External AI should not be called when Antigravity authored metadata');
    },
  });
  const generator = new MetadataGenerator({ aiProviderRouter: router });

  const result = await generator.generate({
    video: SAMPLE_VIDEO,
    aiConfig: { provider: 'gemini', geminiApiKey: 'should-not-call' },
    accountHints: ['youtube:Science Channel', 'instagram:@sciencefacts'],
    customOverrides: {
      authorMode: 'antigravity',
      contentSummary: 'Explains the shared Solanaceae family of potatoes and tomatoes.',
      detectedLanguage: 'en',
      detectedTone: 'curious-educational',
      youtube: {
        title: 'Potato vs Tomato: Same Plant Family Explained',
        description: 'They look nothing alike on your kitchen counter, yet both graft onto one stem.',
        hashtags: ['#botany', '#viral', '#plantscience', '#Shorts'],
        tags: ['potato tomato graft', 'solanaceae', 'fyp', 'botany short'],
        categoryId: '27',
        pinnedComment: 'Would you eat fruit and tubers off the same plant?',
        defaultLanguage: 'en',
        madeForKids: false,
      },
      instagram: {
        caption: 'One stores energy underground while the other advertises bright fruit for birds.',
        hashtags: ['#botany', '#explorepage', '#plantscience'],
        callToAction: 'Save this trivia for dinner tonight!',
        emojis: ['🥔', '🍅'],
        thumbOffsetMs: 12400,
        audioName: 'Original Botany Narration',
      },
    },
  });

  assert.equal(externalAiCalled, false);
  assert.equal(result.providerUsed, 'antigravity:agent');
  assert.equal(result.youtube.title, 'Potato vs Tomato: Same Plant Family Explained');
  assert.equal(result.youtube.categoryId, '27');
  assert.equal(result.youtube.defaultLanguage, 'en');
  assert.equal(result.youtube.madeForKids, false);
  assert.equal(result.youtube.pinnedComment, 'Would you eat fruit and tubers off the same plant?');
  assert.ok(result.youtube.description.includes('#botany'));
  assert.equal(result.youtube.hashtags.includes('#viral'), false);
  assert.equal(result.youtube.tags.includes('fyp'), false);

  assert.ok(result.instagram.caption.includes('Save this trivia for dinner tonight!'));
  assert.ok(result.instagram.caption.includes('#plantscience'));
  assert.equal(result.instagram.hashtags.includes('#explorepage'), false);
  assert.equal(result.instagram.thumbOffsetMs, 12400);
  assert.equal(result.instagram.audioName, 'Original Botany Narration');
});

