'use strict';

/**
 * Application-wide content service registry.
 *
 * Content backends belong to the installation, never to an individual user.
 * Users carry identity/state/preferences only. The manifest URLs stay server-side
 * and are deliberately omitted from the public bootstrap response.
 *
 * Sports is native to this service and is enabled by default. VOD becomes
 * available only when both AIOMetadata (discovery/meta) and AIOStreams
 * (stream resolution/failover) are configured and VOD_ENABLED is truthy.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function enabled(value) {
  return TRUTHY.has(String(value || '').trim().toLowerCase());
}

function normaliseHttpUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function privateConfig() {
  const metadataManifestUrl = normaliseHttpUrl(process.env.AIOMETADATA_MANIFEST_URL);
  const streamsManifestUrl = normaliseHttpUrl(process.env.AIOSTREAMS_MANIFEST_URL);
  const sportsManifestUrl = normaliseHttpUrl(process.env.AIOSPORT_MANIFEST_URL);

  const metadataEnabled = !!metadataManifestUrl;
  const streamsEnabled = !!streamsManifestUrl;
  const vodEnabled = enabled(process.env.VOD_ENABLED) && metadataEnabled && streamsEnabled;

  return {
    sports: {
      enabled: process.env.SPORTS_ENABLED === undefined ? true : enabled(process.env.SPORTS_ENABLED),
      manifestUrl: sportsManifestUrl,
      role: 'live-catalog-and-playback'
    },
    metadata: {
      enabled: metadataEnabled,
      manifestUrl: metadataManifestUrl,
      role: 'vod-catalog-search-and-metadata'
    },
    streams: {
      enabled: streamsEnabled,
      manifestUrl: streamsManifestUrl,
      role: 'vod-playback-resolution-and-failover'
    },
    vod: {
      enabled: vodEnabled
    }
  };
}

function publicBootstrap() {
  const cfg = privateConfig();
  const contentTypes = [];
  if (cfg.sports.enabled) contentTypes.push('sport_event', 'live_channel');
  if (cfg.vod.enabled) contentTypes.push('movie', 'series', 'anime', 'episode');

  return {
    schemaVersion: 2,
    contentTypes,
    playback: {
      mode: 'opaque',
      autoplay: true,
      exposeStreamChoices: false,
      exposeProviderNames: false,
      selectionOwner: 'server'
    },
    services: {
      sports: {
        enabled: cfg.sports.enabled,
        role: cfg.sports.role
      },
      metadata: {
        enabled: cfg.metadata.enabled,
        role: cfg.metadata.role
      },
      streams: {
        enabled: cfg.streams.enabled,
        role: cfg.streams.role
      },
      vod: {
        enabled: cfg.vod.enabled,
        catalogs: cfg.vod.enabled,
        search: cfg.vod.enabled,
        metadata: cfg.vod.enabled,
        opaquePlayback: cfg.vod.enabled,
        selectionOwner: 'aiostreams'
      }
    }
  };
}

function manifestUrl(service) {
  const cfg = privateConfig();
  if (!cfg[service] || !cfg[service].manifestUrl) return '';
  return cfg[service].manifestUrl;
}

module.exports = {
  publicBootstrap,
  manifestUrl,
  _privateConfig: privateConfig,
  _normaliseHttpUrl: normaliseHttpUrl,
  _enabled: enabled
};
