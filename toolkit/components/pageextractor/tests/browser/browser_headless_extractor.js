/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_headless_extraction() {
  const { PageExtractorParent } = ChromeUtils.importESModule(
    "resource://gre/actors/PageExtractorParent.sys.mjs"
  );
  const { url, serverClosed } = serveOnce(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Headless Document</title>
      </head>
      <body>
        <div>This is a headless document</div>
      </body>
    </html>
  `);

  const { text } = await PageExtractorParent.getHeadlessExtractor(
    url,
    async pageExtractor => pageExtractor.getText()
  );

  is(text, "This is a headless document", "The page's content is extracted");

  await serverClosed;
});
