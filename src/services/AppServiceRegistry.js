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

const serviceSettings = require('./ServiceSettings');

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function enabled(value) {
  return TRUTHY.has(String(value || '').trim().toLowerCase());
}

function normaliseHttpUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('stremio://')) value = 'https://' + value.slice('stremio://'.length);
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function selectedValue(saved, key, envName) {
  return Object.prototype.hasOwnProperty.call(saved, key)
    ? saved[key]
    : process.env[envName];
}

function sourceFor(saved, key) {
  return Object.prototype.hasOwnProperty.call(saved, key) ? 'data' : 'environment';
}

function validateManifestUrl(raw, label) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return '';
  const value = normaliseHttpUrl(raw);
  if (!value) {
    const err = new Error(label + ' must be a valid http(s) or stremio manifest URL.');
    err.code = 'INVALID_SERVICE_URL';
    throw err;
  }
  const parsed = new URL(value);
  if (!/\/manifest\.json$/i.test(parsed.pathname)) {
    const err = new Error(label + ' must point to manifest.json.');
    err.code = 'INVALID_SERVICE_URL';
    throw err;
  }
  return value;
}

function privateConfig() {
  const saved = serviceSettings.read();
  const metadataManifestUrl = normaliseHttpUrl(
    selectedValue(saved, 'aiometadataManifestUrl', 'AIOMETADATA_MANIFEST_URL')
  );
  const streamsManifestUrl = normaliseHttpUrl(
    selectedValue(saved, 'aiostreamsManifestUrl', 'AIOSTREAMS_MANIFEST_URL')
  );
  const sportsManifestUrl = normaliseHttpUrl(process.env.AIOSPORT_MANIFEST_URL);
  const sportsEnabled = Object.prototype.hasOwnProperty.call(saved, 'sportsEnabled')
    ? !!saved.sportsEnabled
    : (process.env.SPORTS_ENABLED === undefined ? true : enabled(process.env.SPORTS_ENABLED));

  const metadataEnabled = !!metadataManifestUrl;
  const streamsEnabled = !!streamsManifestUrl;
  const vodRequested = Object.prototype.hasOwnProperty.call(saved, 'vodEnabled')
    ? !!saved.vodEnabled
    : enabled(process.env.VOD_ENABLED);
  const vodEnabled = vodRequested && metadataEnabled && streamsEnabled;

  return {
    sports: {
      enabled: sportsEnabled,
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
      enabled: vodEnabled,
      requested: vodRequested
    },
    sources: {
      sportsEnabled: sourceFor(saved, 'sportsEnabled'),
      metadata: sourceFor(saved, 'aiometadataManifestUrl'),
      streams: sourceFor(saved, 'aiostreamsManifestUrl'),
      vodEnabled: sourceFor(saved, 'vodEnabled')
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

function endpointSummary(url, source) {
  if (!url) return { configured: false, source };
  try {
    const parsed = new URL(url);
    return {
      configured: true,
      source,
      host: parsed.host,
      protocol: parsed.protocol.replace(':', '')
    };
  } catch (_) {
    return { configured: false, source };
  }
}

function adminSummary() {
  const cfg = privateConfig();
  return {
    sports: {
      enabled: cfg.sports.enabled,
      source: cfg.sources.sportsEnabled,
      manifestConfigured: !!cfg.sports.manifestUrl
    },
    vodRequested: cfg.vod.requested,
    vodEnabled: cfg.vod.enabled,
    metadata: endpointSummary(cfg.metadata.manifestUrl, cfg.sources.metadata),
    streams: endpointSummary(cfg.streams.manifestUrl, cfg.sources.streams)
  };
}

function updatePersistentVod(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const err = new Error('Expected a service configuration object.');
    err.code = 'INVALID_SERVICE_CONFIG';
    throw err;
  }

  const current = serviceSettings.read();
  const next = { ...current };

  if (Object.prototype.hasOwnProperty.call(patch, 'sportsEnabled')) {
    next.sportsEnabled = !!patch.sportsEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'vodEnabled')) {
    next.vodEnabled = !!patch.vodEnabled;
  }
  if (patch.clearAiometadata === true) {
    next.aiometadataManifestUrl = '';
  } else if (Object.prototype.hasOwnProperty.call(patch, 'aiometadataManifestUrl')) {
    next.aiometadataManifestUrl = validateManifestUrl(
      patch.aiometadataManifestUrl,
      'AIOMetadata manifest URL'
    );
  }
  if (patch.clearAiostreams === true) {
    next.aiostreamsManifestUrl = '';
  } else if (Object.prototype.hasOwnProperty.call(patch, 'aiostreamsManifestUrl')) {
    next.aiostreamsManifestUrl = validateManifestUrl(
      patch.aiostreamsManifestUrl,
      'AIOStreams manifest URL'
    );
  }

  serviceSettings.write(next);
  return adminSummary();
}

function manifestUrl(service) {
  const cfg = privateConfig();
  if (!cfg[service] || !cfg[service].manifestUrl) return '';
  return cfg[service].manifestUrl;
}

module.exports = {
  publicBootstrap,
  manifestUrl,
  adminSummary,
  updatePersistentVod,
  _privateConfig: privateConfig,
  _normaliseHttpUrl: normaliseHttpUrl,
  _validateManifestUrl: validateManifestUrl,
  _enabled: enabled
};
