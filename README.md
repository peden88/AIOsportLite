<p align="center">
  <img src="public/logo-v2.png" width="120" height="120" alt="AIOSport Lite logo">
</p>

# AIOSport Lite

[![Version](https://img.shields.io/badge/version-v1.6.0--lite.1-brightgreen.svg)](https://github.com/peden88/AIOsportLite/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Forked from](https://img.shields.io/badge/forked_from-rajhodedara%2Flive--sport--plugin-6e7681?logo=github&logoColor=white)](https://github.com/rajhodedara/live-sport-plugin)
[![Ko-fi](https://img.shields.io/badge/Support_on_Ko--fi-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/mlp20)

A self-hosted addon for [Stremio](https://www.stremio.com/) and [Nuvio](https://nuvio.tv) that gathers live sports fixtures and 24/7 channels from several public sources into one catalog.

- **One tile per event.** When several sources carry the same fixture or channel, their streams are merged onto a single tile.
- **Covers for everything.** Fixtures are drawn from both teams' crests, and channels get a cover with their logo. The server renders them, so every player shows the same thing.
- **A tidy Channels tab.** It's sorted A to Z, and channels with nothing playing are hidden until they come back.
- **One application configuration.** Sports, metadata and stream services are configured once by an administrator and apply to every user.
- **Multi-user access.** The first-party web app has real user accounts, revocable sessions and separate administrator permissions.
- **One-button playback.** First-party clients never show a stream/source picker. The server chooses the best candidate and automatically falls through private alternatives when playback fails.

This is a fork of [rajhodedara/live-sport-plugin](https://github.com/rajhodedara/live-sport-plugin). Credit for the original project goes there.

> **Streams come from third-party websites.** AIOSport Lite hosts no video. Sources change and go offline often, so a fixture with no working stream is normal and usually not a problem with your setup.

## Contents

- [Quick start with Docker](#quick-start-with-docker)
- [Install it in Stremio or Nuvio](#install-it-in-stremio-or-nuvio)
- [Updating](#updating)
- [Other ways to run it](#other-ways-to-run-it)
- [Settings](#settings)
- [Accounts and administration](#accounts-and-administration)
- [Optional VOD with AIOMetadata and AIOStreams](#optional-vod-with-aiometadata-and-aiostreams)
- [Catalog tabs](#catalog-tabs)
- [Sources](#sources)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Development](#development)
- [Getting help](#getting-help)
- [License and disclaimer](#license-and-disclaimer)

## Quick start with Docker

You need Docker with Compose v2.24 or newer.

```bash
git clone https://github.com/peden88/AIOsportLite.git
cd AIOsportLite
cp .env.example .env
docker compose up -d --build
```

The first build takes a few minutes. For a real deployment, set `APP_ADMIN_USERNAME` and `APP_ADMIN_PASSWORD` in `.env` before first boot, then open `http://<your computer's IP address>:7000/`. The first administrator is created once and the password is stored only as a salted scrypt hash in the data volume.

The first-party web player fails closed when no account exists unless `ALLOW_OPEN_ACCESS=true` is explicitly set for local development. Read [Accounts and administration](#accounts-and-administration) before exposing the service.

## Install it in Stremio or Nuvio

1. Open `/configure` on your server and pick your sports, sources and teams.
2. Press **Save** to get an install link that ends in `/manifest.json`. You can also copy the link from the install button.
3. Add that link in your player:
   - **Stremio:** paste it into the search box on the Addons page, then press Install.
   - **Nuvio:** go to Settings → Addons and add the link.

### Stremio needs https

Stremio only loads addons over `https://`. The one exception is an addon at `http://127.0.0.1` on the same computer. A home address like `http://192.168.1.50:7000` works in Nuvio but not in Stremio. Two common ways to get https:

- **Cloudflare Tunnel.** Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then run `cloudflared tunnel --url http://127.0.0.1:7000`. That gives you a temporary `https://….trycloudflare.com` address. A named tunnel on your own domain gives you a permanent one.
- **A reverse proxy with a certificate**, such as Caddy, nginx or Traefik, on a domain you control.

Once you have an https address, put it in `.env` as `ADDON_URL=https://your.address` and run `docker compose up -d` again. Reinstall the addon from the https address.

## Updating

```bash
cd aiosports
git pull
docker compose up -d --build --remove-orphans
```

`--build` matters: without it, Compose keeps running the old image. Saved profiles live in the `aiosportlite-data` volume and survive updates. `--remove-orphans` clears out the container from older versions, which used a different service name.

If the manifest id or the tabs changed in a release, the release notes say so. In that case, reinstall the addon in your player.

## Other ways to run it

### Prebuilt image

Every push to `main` publishes `ghcr.io/peden88/aiosportlite:latest` for **linux/amd64 and linux/arm64**. The command below is the same on either: Docker reads your machine's architecture and pulls the matching one. That covers an Oracle Cloud Ampere instance, a Raspberry Pi 4 or 5, and an Apple Silicon Mac, as well as an ordinary x86 server.

```bash
docker run -d --name aiosportlite -p 7000:7000 \
  --env-file .env -e DATA_DIR=/data -v aiosportlite-data:/data \
  --restart unless-stopped ghcr.io/peden88/aiosportlite:latest
```

### Oracle Cloud, and other ARM servers

An Ampere instance runs the command above unchanged -- there is no separate ARM tag to find, and nothing to build. Oracle's Always Free tier gives you four Ampere cores and 24 GB of memory, which is considerably more than this needs.

The one thing that catches people out is not the addon. **A port on an Oracle instance has to be opened in two places**, and opening it in one leaves it shut:

1. **The cloud side.** Add an ingress rule for TCP 7000 to the security list (or network security group) on your instance's subnet, in the console.
2. **The machine itself.** Oracle's own images arrive with host firewall rules that drop nearly everything, and the Ubuntu images do not use `ufw` -- editing it there does nothing. The rules live in `/etc/iptables/rules.v4`.

On that second one, mind where the rule goes: there is a `REJECT` line near the end, and anything added below it never matches. Copy the line that allows SSH, change the port on the copy, and leave the SSH line exactly where it is -- getting that wrong locks you out of the instance.

If you would rather not expose a port at all, put the instance behind a Cloudflare Tunnel as described under [https](#stremio-needs-https). Nothing then listens publicly, and you get the https address Stremio needs in the same move.

### Node.js

Node.js 22 or newer is required.

```bash
git clone https://github.com/peden88/AIOsportLite.git
cd AIOsportLite
cp .env.example .env
npm install
npm start
```

`npm start` builds before it starts, so a separate build step isn't needed. To keep it running in the background with PM2, start it from the `AIOsportLite` folder, because the internal resolver is found relative to that folder:

```bash
npm install -g pm2
pm2 start npm --name aiosportlite -- start
pm2 save
```

## Settings

Settings live in `.env`. Copy `.env.example` and edit it, and restart after a change. These are the ones most people set:

| Variable | What it does |
|---|---|
| `ADDON_URL` | Your public address, e.g. `https://sports.example.com`. Needed for Stremio (see [https](#stremio-needs-https)). |
| `APP_ADMIN_USERNAME` | Username used to create the first administrator when the account store is empty. |
| `APP_ADMIN_PASSWORD` | First administrator password. It is hashed into `DATA_DIR` on first boot and is not used again once accounts exist. |
| `ADMIN_TOKEN` | Optional emergency/legacy administrator credential. Admin accounts can use the dashboard without it. |
| `VOD_ENABLED` | Enables Movies/Series only when both global VOD manifest URLs below are configured. |
| `AIOMETADATA_MANIFEST_URL` | One app-wide AIOMetadata manifest used for VOD catalogs, search and metadata. |
| `AIOSTREAMS_MANIFEST_URL` | One app-wide AIOStreams manifest used for ranked VOD playback and failover. |
| `TZ` | Timezone for kickoff times, for viewers who haven't picked one. |
| `HIDE_EMPTY_CHANNELS` | `0` lists every channel, even ones with no streams right now. |
| `TRUST_PROXY` | Only for a reverse proxy on a public address. See `.env.example`. |
| `RATE_LIMIT` | `off` disables the per-address request limits. |
| `LIVE_BUFFER_SECONDS` | Seconds of extra buffer for every viewer who hasn't chosen their own. `0`, the default, plays as close to live as the source allows. |

`.env.example` explains the rest, including `DATA_DIR`, `LINK_SECRET` and the source-specific options.

## Accounts and administration

The first-party web player and future TV app use the same account store. Ordinary users have a username/password, a role, and revocable device/browser sessions. They do **not** have addon URLs, provider credentials or independent content configurations.

Set these before the first production boot:

```env
APP_ADMIN_USERNAME=admin
APP_ADMIN_PASSWORD=use-a-long-random-password
```

The initial administrator can then open `/users` to create or disable users, change roles/passwords, and sign every device out of an account. `/configure`, `/users` and `/dashboard` are administrator-only once accounts exist.

Existing installations can migrate from the old single `AUTH_KEY`: when the account store is empty and no `APP_ADMIN_PASSWORD` is supplied, the server can create an `admin` account whose initial password is the old `AUTH_KEY`. New installations should use `APP_ADMIN_*` instead.

Browser sessions are HttpOnly cookies. Native/TV clients use the same credentials but receive an opaque revocable Bearer token from `/api/v1/auth/login`. The raw passwords and application manifest URLs are never returned to the client.

The Stremio-compatible addon resources remain usable through their install URLs because Stremio cannot perform the application login. Internal `/watch` handoffs are separately HMAC-signed and expiring, so copying an unsigned web-player URL does not bypass the account gate.

### Application-wide content configuration

There are no user-specific addons in the first-party app. The administrator owns the service configuration and every authenticated user sees the same content backends.

Sports can use the default/saved AIOSport Lite configuration or one explicit app-wide `AIOSPORT_MANIFEST_URL`. User accounts contain personal state such as favourites/watch progress later, not addon/service settings.

## Optional VOD with AIOMetadata and AIOStreams

VOD is intentionally split by responsibility:

- **AIOMetadata** supplies Movies/Series catalogs, search, artwork, title metadata and episode lists.
- **AIOStreams** supplies ranked stream results and its native playback/failover chain.
- **AIOSport Lite** is the authenticated gateway. It keeps both manifest URLs server-side and exposes a first-party API to the web/TV clients.

Configure one manifest for each service:

```env
VOD_ENABLED=true
AIOMETADATA_MANIFEST_URL=https://metadata.example/stremio/<uuid>/manifest.json
AIOSTREAMS_MANIFEST_URL=https://streams.example/<configured-path>/manifest.json
```

`http://`, `https://` and `stremio://` install URLs are accepted; `stremio://` is normalised to HTTPS. Internal Docker-network HTTP URLs are also valid if AIOSport Lite can reach them.

When VOD is enabled, the first-party web app automatically adds **Movies** and **Series**. Search is sent only through AIOMetadata. Series metadata supplies the episode list. Pressing a movie or episode calls the opaque playback API; the user never receives a stream list, addon name, provider name, score or ranking.

AIOStreams remains the authority for stream ordering and resolution. Its owned playback URLs contain its native failover-chain key, so the first playback target can move through AIOStreams' configured debrid/Usenet/fallback policy without the client knowing which provider won. AIOSport Lite keeps additional AIOStreams-ranked media URLs server-side as a second recovery layer for a player-detected failure. VOD `externalUrl` entries are deliberately ignored because they mean “open another page/app”, not guaranteed in-player media.

Administrators can verify the two configured services without exposing their URLs:

```text
GET /api/v1/admin/vod/status
```

The response reports whether each service is configured/reachable plus manifest id/version/resources/types/catalog count. It never includes either manifest URL.

## Catalog tabs

| Tab | Holds |
|---|---|
| 🔴 Live Now | Fixtures in progress. Channels are not mixed in. |
| ⚽ Football | Association football |
| 🏉 Rugby | NRL, Premiership, URC, Top 14, Super Rugby and test rugby |
| 🏎️ Racing | Motorsport |
| 📺 Channels | Every 24/7 channel, A to Z, with a genre filter |
| 🥊 MMA | MMA, boxing and combat-sport events |
| ⏱️ Upcoming · ⭐ Your Teams | Everything ahead, and the teams you follow in `/configure` (including games nobody streams yet -- see below) |
| 📍 Local | The channels of the cities you name in `/configure` (see below) |

In `/configure` you can hide, rename and reorder the tabs.

### What a fixture tile knows

Fixtures are matched against ESPN's scoreboards, which is where the visiting side, the league badge and a kickoff you can trust come from. Two things follow from that:

- **the network carrying the game** is named on the tile -- `📡 On FOX`. It is a line of information, not something to open: what a network station streams free is its news channel, never the broadcast (see below);
- **the kickoff shown is ESPN's** wherever a source site disagrees with it by more than a quarter of an hour. Source sites type the wrong hour often enough to be worth overruling, usually by reading a time zone wrong.

A fixture ESPN has not listed keeps whatever its source said, and nothing on the tile changes.

⭐ Your Teams goes one step further: it lists your teams' fixtures for the week ahead **even when no site has posted a stream yet**, marked `⏳ No streams listed yet`. Links usually appear within an hour or so of kickoff, and until then the tab used to be empty exactly when you were planning your week.

### Local channels

The ABC, CBS, NBC and FOX tiles carry streams from local stations all over the country, each labelled with its city and call sign. Name your own cities under **Local Channels** in `/configure` -- `Chicago, Knoxville TN, Phoenix` -- and:

- each of those cities' stations that iptv-org has a stream for becomes a tile of its own ("FOX 32 Chicago News", "ABC 15 Phoenix News"), in the Channels tab under the Local genre and in the 📍 Local tab, together with channels whose names say the city (CBS News Chicago, Chicago Sports Network);
- your cities' stations are listed first on the network tiles.

What a network station streams free is its 24/7 **news** channel (FOX LOCAL, NBC Chicago News), not its broadcast signal: nobody may stream that, so the network's schedule and the games are never on these tiles. A game is on its own tile in its sport's tab, where the FOX or CBS stream is that game's broadcast. A city shared by several states goes to the one with the TV market; add the state to say otherwise. Only stations somebody has contributed a stream for can be listed, so a small market may have none. `LOCAL_MARKETS` in `.env` adds cities whose stations are listed as tiles for everyone on the server; the 📍 Local tab and the first-place ordering follow each profile's own cities.

## Sources

StreamFree, TimStreams, Streamed.pk, SportyHunter, WatchFooty, CDNLive, StreamSports99, Streamic, TotalSportek, USA TV and iptv-org. Turn each one on or off in `/configure`, and drag them into the order you prefer.

**Sort Streams By** still controls the server-side ranking. *Rating* ranks streams using measured characteristics such as resolution/bitrate and source health; *Source order* prioritises the administrator's configured source order. In the first-party web/TV clients that ranking is never displayed: pressing Play simply starts the highest-ranked working candidate.

## FAQ and troubleshooting

**A fixture has no streams.** The source sites haven't posted one yet, or took it down. Streams often appear shortly before kickoff. Try again closer to the start. The first-party player chooses and retries available sources automatically; there is no source picker. A tile in ⭐ Your Teams marked `⏳ No streams listed yet` is this, said in advance: the game is on ESPN's schedule and no site has posted a link to it.

**What happens when the chosen stream fails?** First-party clients never show the alternatives. AIOSport Lite keeps the ranked candidates private and requests the next one after a fatal startup/playback error. For VOD, the preferred AIOStreams URL also carries AIOStreams' own native failover chain, so debrid/Usenet failover happens before the client-level recovery path is needed.

**Stremio won't install the addon.** It needs an https address; see [Stremio needs https](#stremio-needs-https).

**Covers show only a name for a moment.** The first time a tab opens, the server fetches logos and draws covers. They're cached afterwards -- on the data volume too, so a restart does not draw them again; only an update that changes how cards look draws them once more -- and the server warms them in the background after it starts.

**The server is busy for a few minutes after an update.** Only when the data volume is missing: without it, every restart re-reads every source, refetches every logo and redraws every cover. With `DATA_DIR` on a volume, the catalog, the cards, the logos and the channel checks are all kept, and a restart serves them at once.

**A channel disappeared.** Channels with no streams across two checks at least 15 minutes apart are hidden, and they come back once they play again. `HIDE_EMPTY_CHANNELS=0` shows them all.

**Streamed's streams buffer in Nuvio but play in a browser.** Streamed's CDN only answers clients that look like a browser, so the server fetches its video chunks for the player and relays them. Any host that behaves that way is found out by trying one chunk and relayed from then on; every other host's chunks go straight to the player. Relaying costs the server the stream's bandwidth, a few hundred kilobytes every few seconds per viewer (`PROXY_SEGMENT_HOSTS` in `.env.example`).

**A stream microbuffers -- it never really breaks, but it keeps catching itself.** Usually the source, not the connection. Sources here publish a four-segment playlist and some of them publish in bursts: measured on two of three, eight seconds of nothing and then two segments at once. A player starts three segments from the end of a playlist, which is about twelve seconds of video, so an eight-second pause spends most of the cushion and anything else on top of it stalls. Set **Extra Buffer** in `/configure` (or `LIVE_BUFFER_SECONDS` for everyone) and the server hands the player a deeper window of what the source has already published, and tells it to start further back in it. You see the game that much later, and the bursts stop mattering. Sources that delete a segment the moment they stop listing it are found out and left alone.

**My saved settings were lost after an update.** Profiles are stored in `DATA_DIR`. Compose keeps them on the `aiosportlite-data` volume. With `docker run`, add `-v aiosportlite-data:/data -e DATA_DIR=/data`.

**Port 7000 is already in use.** Change the left side of `"7000:7000"` in `docker-compose.yml`, for example to `"7100:7000"`.

**Can I host it on Render, Vercel or Railway?** It's not recommended. Free app hosts tend to suspend apps that scrape websites or relay media. A spare computer, a Raspberry Pi or a small VPS works better.

**Does it work on a Raspberry Pi?** Yes. The prebuilt image ships for arm64 as well as amd64, so `docker compose up -d` pulls the right one; building from source with the Quick start steps also works.

## Development

```bash
npm install
npm run dev      # restarts on changes to src/
npm test         # channel-merge tests
npm run build    # bundles to dist/
```

Built with Node.js, Express and [stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk). HTTP goes through [impit](https://github.com/apify/impit) with an [undici](https://undici.nodejs.org/) fallback. Artwork is rendered with [sharp](https://sharp.pixelplumbing.com/).

## Getting help

- **Bugs and questions:** open an [issue](https://github.com/peden88/AIOsportLite/issues). The template asks for what's needed.
- **Security problems:** report them privately; see [SECURITY.md](SECURITY.md).
- **Support the project:** [this fork on Ko-fi](https://ko-fi.com/mlp20), or [the upstream project](https://ko-fi.com/rajodedara) it's built on.

## License and disclaimer

AIOSport Lite is released under the [MIT License](LICENSE). It is free, with no paid tiers, and anyone selling access to it is not connected to this project.

- **No hosted media.** The addon doesn't host, store or broadcast video. It lists links that third-party websites already publish and passes them to your player.
- **Not affiliated.** It isn't affiliated with or endorsed by any league, team, broadcaster or streaming service. Their names and logos belong to their owners and appear only to identify content.
- **Your responsibility.** You're responsible for following the laws where you live and the terms of any service you use.
- **Removal requests.** Rights holders can open an issue asking for a source or listing to be removed.
