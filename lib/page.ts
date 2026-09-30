// Tiny standalone HTML pages for the Google sign-in flow.
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function page(title: string, message: string, status = 200, link?: { href: string; label: string }): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · HPP Message Bot</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1c1d; --card: #fff; --accent: #4a154b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1a1d21; --fg: #e8e8e8; --card: #222529; --accent: #b98fd0; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; box-sizing: border-box; }
  main { background: var(--card); max-width: 440px; padding: 32px; border-radius: 12px; box-shadow: 0 1px 4px #0002; }
  h1 { font-size: 1.3rem; margin: 0 0 8px; }
  a.button { display: inline-block; margin-top: 16px; padding: 10px 18px; border-radius: 8px; background: var(--accent);
    color: #fff; text-decoration: none; font-weight: 600; }
</style></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>
${link ? `<a class="button" href="${escape(link.href)}">${escape(link.label)}</a>` : ''}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
