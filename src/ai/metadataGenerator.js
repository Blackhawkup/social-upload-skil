import path from 'node:path';

export const YOUTUBE_CATEGORIES = {
  1: 'Film & Animation',
  2: 'Autos & Vehicles',
  10: 'Music',
  15: 'Pets & Animals',
  17: 'Sports',
  20: 'Gaming',
  22: 'People & Blogs',
  23: 'Comedy',
  24: 'Entertainment',
  25: 'News & Politics',
  26: 'Howto & Style',
  27: 'Education',
  28: 'Science & Technology',
};

const SPAM_HASHTAGS = new Set([
  '#fyp',
  '#foryou',
  '#foryoupage',
  '#viral',
  '#viralshorts',
  '#trending',
  '#explore',
  '#explorepage',
  '#followme',
  '#sub4sub',
  '#like4like',
]);

const STOPWORDS = new Set([
  'about', 'after', 'again', 'almost', 'alone', 'along', 'already', 'always', 'another',
  'around', 'because', 'before', 'being', 'between', 'both', 'built', 'could', 'every',
  'first', 'found', 'from', 'great', 'have', 'here', 'into', 'just', 'like', 'look',
  'looks', 'made', 'make', 'many', 'more', 'most', 'much', 'must', 'never', 'only',
  'other', 'over', 'same', 'some', 'something', 'such', 'than', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'thing', 'think', 'this', 'those', 'through',
  'turn', 'under', 'very', 'want', 'well', 'were', 'what', 'when', 'where', 'which',
  'while', 'will', 'with', 'without', 'would', 'your', 'preview', 'final', 'video', 'output',
]);

function normalizeHashtag(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/[^A-Za-z0-9_\u00C0-\u024F]/g, '');
  if (cleaned.length < 2) return null;
  const tag = `#${cleaned}`;
  if (SPAM_HASHTAGS.has(tag.toLowerCase())) return null;
  return tag;
}

export function normalizeTagList(items = [], maxCount = 15) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const clean = String(item || '').replace(/^#+/, '').trim();
    if (clean.length < 2) continue;
    const key = clean.toLowerCase();
    if (SPAM_HASHTAGS.has(`#${key}`)) continue;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean.slice(0, 60));
    }
    if (out.length >= maxCount) break;
  }
  return out;
}

export function normalizeHashtagList(items = [], maxCount = 6) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const tag = normalizeHashtag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
    if (out.length >= maxCount) break;
  }
  return out;
}

export function formatYouTubeDescription({ description = '', hashtags = [] } = {}) {
  let ytDesc = String(description || '').trim().slice(0, 4900);
  const normHashtags = normalizeHashtagList(hashtags, 5);
  const lower = ytDesc.toLowerCase();
  const missing = normHashtags.filter((h) => !lower.includes(h.toLowerCase()));
  if (missing.length > 0) {
    ytDesc = (ytDesc ? `${ytDesc}\n\n${missing.join(' ')}` : missing.join(' ')).slice(0, 5000);
  }
  return ytDesc;
}

export function formatInstagramCaption({ caption = '', hashtags = [], callToAction = '' } = {}) {
  let igCap = String(caption || '').trim().slice(0, 2150);
  const normHashtags = normalizeHashtagList(hashtags, 8);
  const cta = String(callToAction || '').trim().slice(0, 300);

  if (cta && !igCap.toLowerCase().includes(cta.toLowerCase())) {
    igCap = igCap ? `${igCap}\n\n${cta}` : cta;
  }

  const lower = igCap.toLowerCase();
  const missing = normHashtags.filter((h) => !lower.includes(h.toLowerCase()));
  if (missing.length > 0) {
    igCap = igCap ? `${igCap}\n\n${missing.join(' ')}` : missing.join(' ');
  }

  return igCap.slice(0, 2200);
}

function inferCategoryId(text, accountHints = []) {
  const corpus = `${text} ${accountHints.join(' ')}`.toLowerCase();
  if (/\b(gaming|game|fps|rpg|esports|stream|minecraft|valorant|marvel rivals)\b/.test(corpus)) {
    return '20';
  }
  if (/\b(ai|artificial intelligence|llm|machine learning|coding|software|science|biology|plant|tech|robot)\b/.test(corpus)) {
    return '28';
  }
  if (/\b(news|breaking|announcement|update|policy)\b/.test(corpus)) {
    return '25';
  }
  if (/\b(how to|tutorial|guide|explain|explainer|learn|lesson|why|history)\b/.test(corpus)) {
    return '27';
  }
  if (/\b(animation|animated|whiteboard|stick figure|film|short film)\b/.test(corpus)) {
    return '1';
  }
  return '22';
}

function extractKeywordsFromText(text, maxWords = 10) {
  const counts = new Map();
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWords)
    .map(([w]) => w);
}

function buildDeterministicMetadata({ video, accountHints = [] }) {
  const analysis = video.analysis || {};
  const projectCtx = analysis.projectContext || {};
  const spokenText = (projectCtx.scriptText || projectCtx.transcriptText || '').trim();

  const rawSlug = projectCtx.titleHint
    || (video.projectDir && path.basename(video.projectDir) !== 'out' ? path.basename(video.projectDir) : '')
    || path.basename(video.fileName || 'Video', path.extname(video.fileName || ''));

  const cleanTopicTitle = rawSlug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();

  const sentences = spokenText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const summary = sentences.slice(0, 3).join(' ') || `Video overview for ${cleanTopicTitle}.`;
  const keywords = extractKeywordsFromText(`${cleanTopicTitle} ${spokenText}`, 10);

  const isShort = Boolean(
    (video.aspectRatio === '9:16' || video.aspectRatio === '1:1') &&
    video.durationSec > 0 &&
    video.durationSec <= 180
  );

  const ytTitle = cleanTopicTitle.slice(0, 95);
  const ytHashtags = normalizeHashtagList(keywords.slice(0, 4), 4);
  if (isShort && ytHashtags.length < 5) {
    ytHashtags.push('#Shorts');
  }

  const ytDescription = [
    summary,
    sentences.length > 3 ? `\n${sentences.slice(3, 6).join(' ')}` : '',
    ytHashtags.length ? `\n${ytHashtags.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();

  const categoryId = inferCategoryId(`${cleanTopicTitle} ${spokenText}`, accountHints);

  const igHook = sentences[0] || cleanTopicTitle;
  const igBody = sentences.slice(1, 3).join(' ');
  const igHashtags = normalizeHashtagList(keywords.slice(0, 6), 6);
  const igCta = 'What surprised you most here? Share your thoughts below.';

  const igCaption = [
    igHook,
    igBody ? `\n${igBody}` : '',
    `\n${igCta}`,
    igHashtags.length ? `\n${igHashtags.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();

  return {
    providerUsed: 'deterministic:grounded',
    contentSummary: summary,
    detectedLanguage: projectCtx.languageHint || 'en',
    detectedTone: 'informative',
    youtube: {
      title: ytTitle,
      description: ytDescription,
      hashtags: ytHashtags,
      tags: normalizeTagList([cleanTopicTitle, ...keywords], 12),
      categoryId,
      categoryName: YOUTUBE_CATEGORIES[categoryId] || 'People & Blogs',
      pinnedComment: `Did you expect that twist about ${cleanTopicTitle}? Let us know in the comments.`,
      isShort,
    },
    instagram: {
      caption: igCaption.slice(0, 2200),
      hashtags: igHashtags,
      callToAction: igCta,
      emojis: ['🎬'],
    },
  };
}

export class MetadataGenerator {
  constructor({ aiProviderRouter }) {
    this.aiProviderRouter = aiProviderRouter;
  }

  async generate({ video, aiConfig, accountHints = [], customOverrides = null }) {
    const analysis = video.analysis || {};
    const projectCtx = analysis.projectContext || {};
    const spokenText = (projectCtx.scriptText || projectCtx.transcriptText || '').trim();
    const keyframes = analysis.keyframes || [];

    const fallback = buildDeterministicMetadata({ video, accountHints });

    const ytOv = customOverrides?.youtube || null;
    const igOv = customOverrides?.instagram || null;
    const perAccOv = customOverrides?.perAccount || null;
    const authorMode = String(customOverrides?.authorMode || 'auto').toLowerCase();

    const targetsYt = accountHints.length === 0 || accountHints.some((h) => String(h).startsWith('youtube:'));
    const targetsIg = accountHints.length === 0 || accountHints.some((h) => String(h).startsWith('instagram:'));

    const hasYtAuthored = Boolean(
      ytOv && (ytOv.title || ytOv.description || (Array.isArray(ytOv.hashtags) && ytOv.hashtags.length > 0))
    );
    const hasIgAuthored = Boolean(
      igOv && (igOv.caption || (Array.isArray(igOv.hashtags) && igOv.hashtags.length > 0))
    );
    const hasPerAccountAuthored = Boolean(perAccOv && Object.keys(perAccOv).length > 0);

    const antigravitySuppliedAllTargets =
      authorMode === 'antigravity' ||
      ((hasYtAuthored || hasIgAuthored || hasPerAccountAuthored) &&
        (!targetsYt || hasYtAuthored || hasPerAccountAuthored) &&
        (!targetsIg || hasIgAuthored || hasPerAccountAuthored));

    let generated = fallback;

    if (antigravitySuppliedAllTargets) {
      generated.providerUsed = 'antigravity:agent';
    } else if (authorMode !== 'deterministic') {
      const systemPrompt = [
        'You are an editorial social media strategist generating accurate, grounded YouTube and Instagram metadata.',
        'STRICT RULES:',
        '1. Only describe facts directly supported by the provided video frames, script, transcript, and project metadata.',
        '2. NEVER fabricate statistics, quotes, claims, or unrelated events.',
        '3. NEVER include spam/unrelated trending hashtags like #fyp, #viral, #trending, #explorepage.',
        '4. Adapt tone and formatting separately for YouTube vs Instagram (do not copy identical text).',
        '5. Match the language and tone of the video.',
        '6. Keep YouTube title <= 95 chars without misleading clickbait. Keep YouTube hashtags 2-5 max, tags 5-14 max.',
        '7. Keep Instagram caption engaging with 3-7 strictly relevant hashtags, natural CTA, and tasteful emojis (0-3).',
        'Return ONLY valid JSON with keys: contentSummary, detectedLanguage, detectedTone, youtube { title, description, hashtags, tags, categoryId, pinnedComment }, instagram { caption, hashtags, callToAction, emojis }.',
      ].join('\n');

      const userPrompt = JSON.stringify({
        fileName: video.fileName,
        sourceWorkflow: video.sourceWorkflow,
        durationSec: video.durationSec,
        resolution: `${video.width}x${video.height}`,
        aspectRatio: video.aspectRatio,
        qualifiesAsYouTubeShort:
          (video.aspectRatio === '9:16' || video.aspectRatio === '1:1') && video.durationSec <= 180,
        titleHint: projectCtx.titleHint || '',
        languageHint: projectCtx.languageHint || 'en',
        scriptOrTranscript: spokenText.slice(0, 6000),
        storyboardSummary: (projectCtx.storyboardNotes || '').slice(0, 2000),
        destinationAccountHints: accountHints,
        youtubeCategories: YOUTUBE_CATEGORIES,
      });

      const aiResult = await this.aiProviderRouter.generateStructuredJson({
        aiConfig,
        systemPrompt,
        userPrompt,
        keyframes,
      });

      if (aiResult?.data) {
        generated = this.#sanitizeAiOutput(aiResult.data, fallback, aiResult.provider);
      }
    }

    if (customOverrides) {
      if (customOverrides.contentSummary) {
        generated.contentSummary = String(customOverrides.contentSummary).trim().slice(0, 1000);
      }
      if (customOverrides.detectedLanguage) {
        generated.detectedLanguage = String(customOverrides.detectedLanguage).trim().slice(0, 16);
      }
      if (customOverrides.detectedTone) {
        generated.detectedTone = String(customOverrides.detectedTone).trim().slice(0, 64);
      }

      if (ytOv) {
        const catId =
          ytOv.categoryId && YOUTUBE_CATEGORIES[String(ytOv.categoryId)]
            ? String(ytOv.categoryId)
            : generated.youtube.categoryId;
        const ytHashtags = normalizeHashtagList(ytOv.hashtags || generated.youtube.hashtags, 5);
        const rawDesc = ytOv.description !== undefined ? ytOv.description : generated.youtube.description;
        generated.youtube = {
          ...generated.youtube,
          ...ytOv,
          title: String(ytOv.title || generated.youtube.title).trim().slice(0, 100),
          description: formatYouTubeDescription({ description: rawDesc, hashtags: ytHashtags }),
          hashtags: ytHashtags,
          tags: normalizeTagList(ytOv.tags || generated.youtube.tags, 15),
          categoryId: catId,
          categoryName: YOUTUBE_CATEGORIES[catId] || generated.youtube.categoryName || 'People & Blogs',
          pinnedComment: String(
            ytOv.pinnedComment !== undefined ? ytOv.pinnedComment : generated.youtube.pinnedComment || ''
          ).slice(0, 1000),
          defaultLanguage: String(ytOv.defaultLanguage || generated.detectedLanguage || 'en').slice(0, 16),
          madeForKids: ytOv.madeForKids !== undefined ? Boolean(ytOv.madeForKids) : Boolean(generated.youtube.madeForKids ?? false),
        };
      }

      if (igOv) {
        const igHashtags = normalizeHashtagList(igOv.hashtags || generated.instagram.hashtags, 8);
        const igCta = String(
          igOv.callToAction !== undefined ? igOv.callToAction : generated.instagram.callToAction || ''
        )
          .trim()
          .slice(0, 300);
        const rawCaption = igOv.caption !== undefined ? igOv.caption : generated.instagram.caption;
        generated.instagram = {
          ...generated.instagram,
          ...igOv,
          caption: formatInstagramCaption({
            caption: rawCaption,
            hashtags: igHashtags,
            callToAction: igOv.caption !== undefined ? igOv.callToAction || '' : igCta,
          }),
          hashtags: igHashtags,
          callToAction: igCta,
          emojis: Array.isArray(igOv.emojis) ? igOv.emojis.slice(0, 5) : generated.instagram.emojis,
          ...(igOv.thumbOffsetMs !== undefined ? { thumbOffsetMs: Math.max(0, Math.floor(Number(igOv.thumbOffsetMs))) } : {}),
          ...(igOv.audioName ? { audioName: String(igOv.audioName).slice(0, 120) } : {}),
        };
      }

      if ((hasYtAuthored || hasIgAuthored) && !antigravitySuppliedAllTargets) {
        generated.providerUsed = `${generated.providerUsed}+antigravity`;
      }
    }

    return generated;
  }

  #sanitizeAiOutput(raw, fallback, providerUsed) {
    const ytRaw = raw.youtube || {};
    const igRaw = raw.instagram || {};
    const catId = YOUTUBE_CATEGORIES[String(ytRaw.categoryId)] ? String(ytRaw.categoryId) : fallback.youtube.categoryId;

    const ytHashtags = normalizeHashtagList(ytRaw.hashtags || fallback.youtube.hashtags, 5);
    const ytTags = normalizeTagList(ytRaw.tags || fallback.youtube.tags, 15);
    const igHashtags = normalizeHashtagList(igRaw.hashtags || fallback.instagram.hashtags, 8);

    const ytDesc = formatYouTubeDescription({
      description: ytRaw.description || fallback.youtube.description,
      hashtags: ytHashtags,
    });
    const igCta = String(igRaw.callToAction || fallback.instagram.callToAction || '').slice(0, 300);
    const igCap = formatInstagramCaption({
      caption: igRaw.caption || fallback.instagram.caption,
      hashtags: igHashtags,
      callToAction: '',
    });

    return {
      providerUsed,
      contentSummary: String(raw.contentSummary || fallback.contentSummary).slice(0, 1000),
      detectedLanguage: String(raw.detectedLanguage || fallback.detectedLanguage || 'en'),
      detectedTone: String(raw.detectedTone || fallback.detectedTone || 'informative'),
      youtube: {
        title: String(ytRaw.title || fallback.youtube.title).trim().slice(0, 100),
        description: ytDesc,
        hashtags: ytHashtags,
        tags: ytTags,
        categoryId: catId,
        categoryName: YOUTUBE_CATEGORIES[catId] || 'People & Blogs',
        pinnedComment: String(ytRaw.pinnedComment || fallback.youtube.pinnedComment || '').slice(0, 1000),
        defaultLanguage: String(ytRaw.defaultLanguage || raw.detectedLanguage || fallback.detectedLanguage || 'en').slice(0, 16),
        madeForKids: Boolean(ytRaw.madeForKids ?? false),
        isShort: fallback.youtube.isShort,
      },
      instagram: {
        caption: igCap,
        hashtags: igHashtags,
        callToAction: igCta,
        emojis: Array.isArray(igRaw.emojis) ? igRaw.emojis.slice(0, 5) : fallback.instagram.emojis,
      },
    };
  }
}

