// Typed SDK for reading the signed-in user's X bookmarks through the page's own
// network session. Import it inside a playwriter sandbox and pass `page`.
// Everything runs as fetch() inside x.com, so cookies apply. No DOM clicks.
//
// Lessons from reverse-engineering (recording 138, Sep 2026):
// - Bookmarks is GraphQL GET /i/api/graphql/<queryId>/Bookmarks. queryId and
//   the huge `features` object rotate with X deploys, so we never hardcode them.
//   discoverBookmarksQuery() navigates to /i/bookmarks and copies them from the
//   real request the web app sends.
// - Replaying without x-client-transaction-id works (200). Required headers:
//   authorization (public web bearer), x-csrf-token (= ct0 cookie), cookies.
// - Query id is not in main.js; it lives in a lazy chunk. Do not scan bundles.
// - Long posts: full text is in note_tweet.note_tweet_results.result.text,
//   legacy.full_text is truncated. Some results are wrapped in
//   TweetWithVisibilityResults { tweet }.
// - legacy.full_text is HTML-escaped (&amp; &lt; &gt;).
// - Pagination: entry with entryId "cursor-bottom-*" holds the next cursor. An
//   empty page (only cursor entries) means the end.

export type XMediaType = 'photo' | 'video' | 'animated_gif'

export interface XMedia {
  type: XMediaType
  /** image url, or poster image for videos */
  url: string
  width?: number
  height?: number
  altText?: string
  /** highest bitrate mp4 for videos and gifs */
  videoUrl?: string
  durationMs?: number
}

export interface XUser {
  id: string
  name: string
  screenName: string
  avatarUrl?: string
  isBlueVerified: boolean
}

export interface XLink {
  url: string
  expandedUrl: string
  displayUrl: string
}

export interface XTweet {
  id: string
  url: string
  /** full text, long posts included, t.co links expanded, media links removed */
  text: string
  /** ISO 8601 */
  createdAt: string
  lang?: string
  author: XUser
  metrics: {
    likes: number
    retweets: number
    replies: number
    quotes: number
    bookmarks: number
    views?: number
  }
  media: XMedia[]
  links: XLink[]
  inReplyTo?: { tweetId: string; screenName?: string }
  article?: { id: string; title: string; previewText?: string }
  quoted?: XTweet
}

export interface BookmarksQuery {
  queryId: string
  /** raw `features` query param copied from the web app */
  features: string
  authorization: string
}

export interface BookmarksPage {
  bookmarks: XTweet[]
  nextCursor?: string
}

/** Minimal slice of the Playwright Page we use, so this file has no deps. */
export interface PageLike {
  url(): string
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load' }): Promise<unknown>
  waitForRequest(
    predicate: (req: { url(): string; headers(): Record<string, string> }) => boolean,
    options?: { timeout?: number },
  ): Promise<{ url(): string; headers(): Record<string, string> }>
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>
  close(): Promise<void>
}

/** Minimal slice of the Playwright BrowserContext. */
export interface ContextLike {
  newPage(): Promise<PageLike>
}

const BOOKMARKS_PATH = /\/i\/api\/graphql\/([^/]+)\/Bookmarks\?/

/** Load /i/bookmarks once and copy queryId, features and bearer from the real request. */
export async function discoverBookmarksQuery({ page }: { page: PageLike }): Promise<BookmarksQuery> {
  const [req] = await Promise.all([
    page.waitForRequest((r) => BOOKMARKS_PATH.test(r.url()), { timeout: 20000 }),
    page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded' }),
  ])
  const url = new URL(req.url())
  const queryId = url.pathname.match(/graphql\/([^/]+)\/Bookmarks/)?.[1]
  const features = url.searchParams.get('features')
  const authorization = req.headers()['authorization']
  if (!queryId || !features || !authorization) {
    throw new Error(`Could not read Bookmarks query from ${req.url()}`)
  }
  return { queryId, features, authorization }
}

/** Fetch one page of bookmarks. `page` must be on x.com. */
export async function fetchBookmarksPage({
  page,
  query,
  count = 20,
  cursor,
}: {
  page: PageLike
  query: BookmarksQuery
  count?: number
  cursor?: string
}): Promise<BookmarksPage> {
  if (!page.url().startsWith('https://x.com/')) {
    throw new Error(`page must be on https://x.com, got ${page.url()}`)
  }
  const variables = JSON.stringify({ count, includePromotedContent: false, ...(cursor ? { cursor } : {}) })
  const url =
    `https://x.com/i/api/graphql/${query.queryId}/Bookmarks` +
    `?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(query.features)}`

  const res = await page.evaluate(
    async ({ url, authorization }) => {
      const ct0 = document.cookie.match(/(?:^|; )ct0=([^;]+)/)?.[1]
      if (!ct0) return { status: 0, text: 'missing ct0 cookie, user is not logged in' }
      const r = await fetch(url, {
        credentials: 'include',
        headers: {
          authorization,
          'x-csrf-token': ct0,
          'content-type': 'application/json',
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-client-language': 'en',
        },
      })
      return { status: r.status, text: await r.text() }
    },
    { url, authorization: query.authorization },
  )
  if (res.status !== 200) {
    throw new Error(`Bookmarks request failed: ${res.status} ${res.text.slice(0, 300)}`)
  }
  return parseBookmarksResponse(JSON.parse(res.text))
}

/** Latest `limit` bookmarks, newest first. Opens its own tab and always closes it. */
export async function getLatestBookmarks({
  context,
  limit = 20,
}: {
  context: ContextLike
  limit?: number
}): Promise<XTweet[]> {
  const page = await context.newPage()
  const all: XTweet[] = []
  try {
    const query = await discoverBookmarksQuery({ page })
    let cursor: string | undefined
    while (all.length < limit) {
      const result = await fetchBookmarksPage({ page, query, cursor, count: Math.min(100, limit - all.length) })
      all.push(...result.bookmarks)
      if (!result.bookmarks.length || !result.nextCursor || result.nextCursor === cursor) break
      cursor = result.nextCursor
    }
  } finally {
    await page.close()
  }
  return all.slice(0, limit)
}

// ---------- parsing ----------

// Raw GraphQL payloads are huge and loosely shaped; parse defensively.
type Raw = any

export function parseBookmarksResponse(json: Raw): BookmarksPage {
  const errors = json?.errors
  const instructions: Raw[] = json?.data?.bookmark_timeline_v2?.timeline?.instructions ?? []
  if (!instructions.length && errors?.length) {
    throw new Error(`Bookmarks GraphQL error: ${errors.map((e: Raw) => e.message).join('; ')}`)
  }
  const entries: Raw[] = instructions.flatMap((i) => i.entries ?? [])
  const bookmarks: XTweet[] = []
  let nextCursor: string | undefined
  for (const entry of entries) {
    const content = entry.content
    if (content?.cursorType === 'Bottom') nextCursor = content.value
    const tweet = parseTweet(content?.itemContent?.tweet_results?.result)
    if (tweet) bookmarks.push(tweet)
  }
  return { bookmarks, nextCursor }
}

function unwrapTweet(result: Raw): Raw {
  if (result?.__typename === 'TweetWithVisibilityResults') return result.tweet
  return result
}

function parseTweet(rawResult: Raw): XTweet | undefined {
  const t = unwrapTweet(rawResult)
  if (!t?.legacy || !t.rest_id) return undefined
  const legacy = t.legacy
  const user = t.core?.user_results?.result
  const screenName: string = user?.core?.screen_name ?? user?.legacy?.screen_name ?? ''

  const note = t.note_tweet?.note_tweet_results?.result
  const entities = note?.entity_set ?? legacy.entities ?? {}
  const links: XLink[] = (entities.urls ?? []).map((u: Raw) => ({
    url: u.url,
    expandedUrl: u.expanded_url,
    displayUrl: u.display_url,
  }))
  const rawMedia: Raw[] = legacy.extended_entities?.media ?? legacy.entities?.media ?? []

  let text: string = note?.text ?? legacy.full_text ?? ''
  for (const link of links) text = text.split(link.url).join(link.expandedUrl)
  for (const m of rawMedia) if (m.url) text = text.split(m.url).join('')
  // X escapes only these three in tweet text
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()

  const article = t.article?.article_results?.result
  const views = t.views?.count

  return {
    id: t.rest_id,
    url: `https://x.com/${screenName}/status/${t.rest_id}`,
    text,
    createdAt: new Date(legacy.created_at).toISOString(),
    lang: legacy.lang,
    author: {
      id: user?.rest_id ?? legacy.user_id_str,
      name: user?.core?.name ?? user?.legacy?.name ?? '',
      screenName,
      avatarUrl: user?.avatar?.image_url ?? user?.legacy?.profile_image_url_https,
      isBlueVerified: Boolean(user?.is_blue_verified),
    },
    metrics: {
      likes: legacy.favorite_count ?? 0,
      retweets: legacy.retweet_count ?? 0,
      replies: legacy.reply_count ?? 0,
      quotes: legacy.quote_count ?? 0,
      bookmarks: legacy.bookmark_count ?? 0,
      views: views ? Number(views) : undefined,
    },
    media: rawMedia.map(parseMedia),
    links,
    inReplyTo: legacy.in_reply_to_status_id_str
      ? { tweetId: legacy.in_reply_to_status_id_str, screenName: legacy.in_reply_to_screen_name }
      : undefined,
    article: article
      ? { id: article.rest_id, title: article.title, previewText: article.preview_text }
      : undefined,
    quoted: parseTweet(t.quoted_status_result?.result),
  }
}

function parseMedia(m: Raw): XMedia {
  const mp4s: Raw[] = (m.video_info?.variants ?? []).filter((v: Raw) => v.content_type === 'video/mp4')
  const best = mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]
  return {
    type: m.type,
    url: m.media_url_https,
    width: m.original_info?.width,
    height: m.original_info?.height,
    altText: m.ext_alt_text ?? undefined,
    videoUrl: best?.url,
    durationMs: m.video_info?.duration_millis,
  }
}
