import { PlatformError } from './retry.js';

export class MetadataService {
  constructor({ videoService, videosRepo, accountsRepo, credentialStore, metadataGenerator, config }) {
    this.videoService = videoService;
    this.videosRepo = videosRepo;
    this.accountsRepo = accountsRepo;
    this.credentialStore = credentialStore;
    this.metadataGenerator = metadataGenerator;
    this.config = config;
  }

  async generateForVideo({ videoId = null, videoPath = null, accountIds = [], customOverrides = null }) {
    const video = videoId
      ? this.videosRepo.findById(videoId)
      : await this.videoService.analyzeVideo({ videoPath, extractFrames: true });

    if (!video) {
      throw new PlatformError(`Video not found: ${videoId || videoPath}`, {
        code: 'VIDEO_NOT_FOUND',
        statusCode: 404,
      });
    }

    const accounts = accountIds
      .map((id) => this.accountsRepo.findPublicById(id))
      .filter(Boolean);
    const accountHints = accounts.map((a) => `${a.platform}:${a.displayName}`);

    const creds = this.credentialStore.resolveEffectiveCredentials(this.config);
    const generated = await this.metadataGenerator.generate({
      video,
      aiConfig: creds.ai,
      accountHints,
      customOverrides,
    });

    const ytDraft = this.videosRepo.saveMetadataDraft({
      videoId: video.id,
      platform: 'youtube',
      providerUsed: generated.providerUsed,
      payload: generated.youtube,
    });

    const igDraft = this.videosRepo.saveMetadataDraft({
      videoId: video.id,
      platform: 'instagram',
      providerUsed: generated.providerUsed,
      payload: generated.instagram,
    });

    return {
      videoId: video.id,
      filePath: video.filePath,
      fileName: video.fileName,
      providerUsed: generated.providerUsed,
      contentSummary: generated.contentSummary,
      detectedLanguage: generated.detectedLanguage,
      detectedTone: generated.detectedTone,
      youtube: generated.youtube,
      instagram: generated.instagram,
      draftIds: {
        youtube: ytDraft.id,
        instagram: igDraft.id,
      },
    };
  }
}

