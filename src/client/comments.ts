/**
 * giscus wiring for the in-pluginhub comment thread.
 *
 * A plugin has ONE discussion, whether the reader reached it from
 * github.com/funcodingdev/dsh-community-plugins, from the dsh-plugin-hub catalog, or from inside the
 * pluginhub itself. That is only true as long as three things agree across the
 * three surfaces: the repository ids below, the `plugin:<slug>` term, and the
 * slug those terms are built from. The ids here mirror site/comments.mjs and
 * the slug mirrors scripts/build-site.mjs; both are asserted in
 * tests/client/comments.client.spec.ts against the real files, because a
 * silent disagreement does not fail — it forks the conversation in half and
 * nobody notices until someone asks why their comment vanished.
 */

export const GISCUS = Object.freeze({
  repo: 'funcodingdev/dsh-community-plugins',
  repoId: '',
  category: '',
  categoryId: '',
})

/** Enabled after this repository has its own Discussions category and IDs. */
export const COMMENTS_ENABLED = false

/**
 * The plugin's slug, derived from its GitHub URL exactly as the two site
 * builders derive it. Entries that live in a subdirectory of a monorepo
 * (`.../tree/<ref>/packages/x`) get the `owner/repo--packages-x` form, so two
 * plugins from one repository do not share a thread.
 */
export function pluginSlug(url: string): string {
  const repoPath = url.replace('https://github.com/', '')
  const repo = repoPath.split('/').slice(0, 2).join('/')
  const sub = repoPath.includes('/tree/')
    ? repoPath.split('/tree/')[1]!.replace(/^[^/]+\//, '')
    : null
  return sub ? `${repo}--${sub.replaceAll('/', '-')}` : repo
}

/** The giscus discussion term for a plugin. */
export const commentsTerm = (url: string): string => `plugin:${pluginSlug(url)}`

/** giscus's own locale codes, which are not the ones this plugin uses. */
export const giscusLang = (lang: string): string => (lang === 'zh' ? 'zh-CN' : 'en')
