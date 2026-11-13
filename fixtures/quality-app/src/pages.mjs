const shell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; font: 16px/1.5 sans-serif; background: #ffffff; color: #1a1a1a; }
  main { padding: 32px; }
  h1 { color: #1f4e8c; font-size: 32px; margin: 0 0 16px; }
  .card { background: #eef3fa; border-radius: 8px; padding: 24px; width: 400px; height: 120px; }
</style></head>
<body><main>${body}</main></body></html>`;

export const pages = {
  '/': (greeting) => shell('Home', `<h1>${greeting}</h1><div class="card">A card with a fixed size.</div><p><a href="/form">Go to the form</a></p>`),
  '/form': () => shell('Form', `<h1>Sign up</h1><form><label for="email">Email</label> <input id="email" type="email"> <button type="submit">Send</button></form>`),
};
