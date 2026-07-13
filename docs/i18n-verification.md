# In-game terminology verification

The app's localized titles and copy should use the **same words the game uses**, because those are the words players recognize and the words they type into Google.

Literal translation is not good enough. The English event is "Treasure Hunt" (confirmed), but Simplified Chinese calls it **营地寻宝**, "*Camp* Treasure Hunt". The Chinese localizers added a qualifier that is not in the English source. So **each locale's event name is whatever that locale's translators chose, and cannot be derived from English by translating it.** Every locale has to be read off the real client.

This file tracks which locales have been verified against the game, and what is still guessed.

## The game ships in 16 languages

Confirmed from the in-game language selector (2026-07-12), and matching the App Store listing.

**The in-game selector labels each language in its own script**, which makes it easy to tap the wrong one. This table maps the button you see in game, in menu order, to the locale code in `I18N`:

| # | Button in game | Language | Our locale code |
|---|---|---|---|
| 1 | 中文 | Chinese (Simplified) | `zh-Hans` |
| 2 | English | English | `en` |
| 3 | 한국어 | Korean | `ko` |
| 4 | 日本語 | Japanese | `ja` |
| 5 | Deutsch | German | `de` |
| 6 | Italiano | Italian | `it` |
| 7 | 中文繁體 | Chinese (Traditional) | `zh-Hant` |
| 8 | Français | French | `fr` |
| 9 | Indonesia | Indonesian | `id` |
| 10 | Polski | Polish | `pl` |
| 11 | Português | Portuguese | `pt` |
| 12 | Русский | Russian | `ru` |
| 13 | Español | Spanish | `es` |
| 14 | ภาษาไทย | Thai | `th` |
| 15 | Türkçe | Turkish | *(no locale)* |
| 16 | Tiếng Việt | Vietnamese | `vi` |

Two consequences:

- **Dutch has no client.** Dutch players read the game in English, so there is no in-game wording to match and nothing to verify. The Dutch locale keeps its literal translation, and a Dutch SEO page has little keyword value.
- **Turkish has a client but no UI locale here** (~66 sessions, below the cutoff). Add one only if Turkish traffic grows.

## What to capture, per language

Switch the game client to the language, then take three screenshots:

1. **Event banner** — the event's entry tile/icon showing its name. → gives the **event name** (the primary SEO keyword).
2. **Pickaxe item tooltip** — tap the pickaxe to open its item card. → gives the **pickaxe item name**, and repeats the event name in the description as a cross-check.
3. **Stage indicator** — the stage chip on the board. → gives the **"Stage N" format**.

Optional: the **bomb item tooltip**, only if we want the "ignores bombs" line to match the game. Low value.

### Reference: what a complete answer looks like (zh-Hans, verified)

| Thing | In-game | Used in |
|---|---|---|
| Event name | 营地寻宝 | `app.title`, `app.pageTitle` |
| Pickaxe item | 铁镐 | `setup.pickPerTile`, `setup.pickInfo`, `estimate.*` |
| Stage label | 第四关 → `第{n}关` | `stage.option` |

## Status

Ordered by traffic.

| Language | Sessions | Event name | Pickaxe | Stage | Notes |
|---|---|---|---|---|---|
| English | 18,288 | ✅ Treasure Hunt | ❗ | ❗ | **Confirmed correct as shipped.** The 营地 ("camp") qualifier is something the Chinese localization added; it is not in the English source. So each locale's name is whatever that locale's translators chose, and cannot be derived from English. |
| Spanish | 1,469 | ❗ | ❗ | ❗ | Current "Búsqueda del tesoro" is a literal guess. |
| French | 1,253 | ❗ | ❗ | ❗ | Current "Chasse au trésor" is a literal guess. |
| Thai | 1,195 | ❗ | ❗ | ❗ | |
| Russian | 935 | ❗ | ❗ | ❗ | Current "Охота за сокровищами" is a literal guess. |
| Indonesian | 737 | ❗ | ❗ | ❗ | |
| German | 682 | ❗ | ❗ | ❗ | Current "Schatzsuche" is a literal guess. |
| Chinese (Simplified) | 492 | ✅ 营地寻宝 | ✅ 铁镐 | ✅ 第{n}关 | **Verified in-game.** |
| Chinese (Traditional) | ↑ | ✅ 營地尋寶 | ✅ 鐵鎬 | ✅ 第{n}關 | **Verified in-game.** The character conversion from Simplified held exactly. |
| Portuguese | 478 | ❗ | ❗ | ❗ | Current "Caça ao tesouro" is a literal guess. |
| Italian | 421 | ❗ | ❗ | ❗ | |
| Vietnamese | 224 | ❗ | ❗ | ❗ | Game *name* verified: **Chiến Thú Hỗn Chiến** (Play Store). Event/pickaxe/stage still guessed. |
| Polish | 200 | ❗ | ❗ | ❗ | |
| Korean | 69 | ❗ | ❗ | ❗ | |
| Japanese | 12 | ❗ | ❗ | ❗ | |
| Dutch | 190 | N/A | N/A | N/A | No game client. Nothing to verify. |

## Official game name by locale

Verified from Google Play listings (2026-07-12). Most locales keep the Latin brand.

- en, de, es, pt, fr, ru, th, id, it, pl, nl: **Clash of Critters**
- vi: **Chiến Thú Hỗn Chiến** (the only Latin-script locale that localizes the brand)
- ja: モンスターサバイバル
- ko: 뚜까펫: 서바이벌
- zh-Hans: 塔塔冒险队
- zh-Hant: 塔塔冒險隊

## SEO trap

Generic translated event names collide with **Clash of Clans**, which has its own "Treasure Hunt" event and is orders of magnitude bigger. Italian "Caccia al tesoro" and Indonesian "Berburu Harta Karun" plus "Clash" both return Supercell content. Keep the brand token prominent in every localized title.
