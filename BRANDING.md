# AIOPlay brand system

## Product name

**AIOPlay** is the only user-facing application name. It represents the complete media experience rather than any single content type.

Do not use AIOSport, AIOSports, AIOSport Lite or sport-specific wording as product branding. Those names may remain only where required as legacy technical identifiers.

## Primary assets

### In-app mark

`public/brand/aioplay-mark.svg`

Use for:
- app navigation/header identity
- web header
- login/account surfaces
- settings and administration
- player overlay
- favicons and small marks
- future Android TV in-app branding

The mark is the white **AIO** monogram over a cyan → blue → violet play symbol on a dark rounded-square field.

### Launcher / splash banner

`public/brand/aioplay-launcher.svg`

Use as the source for:
- Android TV launcher banner
- launch/splash artwork
- large branded hero surfaces where a horizontal lockup is needed

For Android builds, rasterize this source into the exact launcher/banner sizes required by the target SDK rather than redrawing it.

## Core palette

- Background: `#020307`
- Deep navy: `#07122F`
- Cyan: `#20E8FF`
- Blue: `#086CFF`
- Deep blue: `#1537D6`
- Violet: `#9B2CFF`
- Foreground: `#FFFFFF`

Gradients should flow cyan → blue → violet. Keep glow restrained outside splash/launcher surfaces.

## Product rule

The global shell must stay content-neutral. Football, Rugby, Racing, MMA, Movies, Series and Channels can have their own imagery inside catalog/content areas, but none of those categories should alter the AIOPlay logo, launcher identity, login screen, navigation shell or player chrome.

## Compatibility

The following are intentionally not renamed during the branding pass:
- repository: `peden88/AIOsportLite`
- container/image/service names currently using `aiosportlite`
- Stremio manifest id: `community.aiosportlite`
- legacy localStorage/config format identifiers such as `aiosports.profileKeys` and `aiosports.config`

Changing them would turn a visual branding update into a migration and could break existing installs or backups.
