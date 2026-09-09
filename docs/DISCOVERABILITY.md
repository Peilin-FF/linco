# Product story and discoverability

## Positioning

Linco is an **open-source desktop workspace for vibe coding**: your CLI coding
agent, live preview, code, Git, terminal and project memory in one place.

Lead with the development loop, not a list of buttons. Demonstrate a small,
editable project first; then show local/remote workflows and structured memory.
Use concrete examples, distinguish scripted demos from real agent work, and do
not invent customer testimonials, usage numbers or performance claims.

## Shipped foundations

- English and Chinese READMEs with real-interface screenshots, setup links and examples.
- A static, crawlable landing page around a JavaScript playground.
- A descriptive title, meta description, canonical URL and Open Graph/Twitter preview.
- Accurate `SoftwareApplication` JSON-LD, without fabricated reviews or ratings.
- A sitemap containing the canonical landing page.
- A separate demo build with synthetic data; no analytics added.
- A public playground at [peilin-ff.github.io/linco](https://peilin-ff.github.io/linco/), linked directly from both READMEs.

## Publication and search checklist

1. Keep **Settings → Pages → Source: GitHub Actions** enabled. The **Product demo**
   workflow publishes to `https://peilin-ff.github.io/linco/`.
2. Confirm the site returns HTTP 200 and that the demo, image and sitemap work.
3. Update the repository About description and website. Suggested topics:
   `vibe-coding`, `ai-coding`, `developer-tools`, `tauri`, `coding-agent`,
   `remote-development`, `terminal`, `notion`.
4. Verify the site in Google Search Console and submit
   `https://peilin-ff.github.io/linco/sitemap.xml`. This requires owner access;
   it is not performed by a source-code commit.
5. Use Search Console URL Inspection to verify rendering and indexing, then
   review impressions and clicks after enough time has passed to be meaningful.
6. Add useful, evidence-backed guides based on real workflows: building a small
   site, debugging a UI regression, inspecting remote task logs, and resuming
   project work with selected notes. Avoid thin keyword-variant pages.

GitHub project Pages live under `/linco/`; a `robots.txt` there does not control
the domain root. Do not claim a repository-level robots file controls crawlers
for the entire `peilin-ff.github.io` domain.

Search visibility and ranking are not guaranteed. These choices follow
[Google's SEO starter guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
and [GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
