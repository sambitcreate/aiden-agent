# Images in desktop chat replies

An HTTP, HTTPS or protocol-relative Markdown image in an assistant reply starts as a placeholder with its alt text, site name and **Load image** button. Streaming text and saved chat history do not contact the image's site. Tab to the button and press Enter or Space to load that image.

The choice applies to that displayed message and exact URL in the current window document. A changed URL or another message asks again. Reloading or reopening the window clears the choice. There is no global allow-all setting or saved permission.

After the click, Aiden's main process downloads the image without cookies, provider credentials or a chat/document referrer. It checks the resolved network addresses at socket creation and checks every redirect. Loopback, private, link-local and other non-public addresses are blocked, including private DNS answers and redirects. Relative paths do not load against the application's local document.

Only PNG, JPEG and WebP responses with matching raster signatures and valid structure are accepted. GIF, BMP and SVG links do not load in this flow. Downloads have an 8 MB decoded-body limit, a 20-second timeout and at most five redirects. Images also use Aiden's existing decoder limits, at most 16,384 pixels on either edge and 20 million pixels in total. An unsupported, oversized or failed image leaves the placeholder and an accessible error message.

The renderer receives verified image bytes and dimensions, never a remote image source to fetch. Loaded images retain their alt text and fit the transcript column. The placeholder uses the app's semantic surface and text colors and shared keyboard-accessible button. No animation is added.

Generated images, shared local image attachments, their full-view previews and authenticated Create Images asset grants retain their existing behavior. Native iOS Markdown already suppresses network images, and Android's transcript formatter renders text and link annotations without fetching Markdown images. This desktop flow changes no Remote wire contract or CLI behavior.
