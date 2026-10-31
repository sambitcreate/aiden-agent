# RFB server transcripts

Synthetic until owner-Mac acceptance; replace or add recorded transcripts.

Each `.bin` file is everything a VNC server sends a client, from the
`RFB 003.008\n` banner on, with no client bytes in it. `rfb-client.test.ts`
replays a file into `connectRfb` and checks the decoded framebuffer. All of
these use security type None and a 32-bit little-endian true-colour
ServerInit (shifts 16/8/0, so the client sends no SetPixelFormat).

| File | After the 1024×768 ServerInit (`aiden-fixture`) |
|---|---|
| `server-init-1024x768.bin` | nothing |
| `raw-rect.bin` | one update: a Raw 4×2 rect at (100, 200), red, green, blue, white, then white, blue, green, red |
| `copy-rect.bin` | a Raw 2×2 rect at (0, 0) (red, green / blue, white), then a CopyRect of it to (500, 300) |
| `desktop-size.bin` | a DesktopSize to 800×600, then a Raw green pixel at (799, 599) |

## Recording real transcripts on the owner Mac

Start Aiden with `AIDEN_BOT_COMPUTERS_RECORD_RFB=1`, open a Bot's Computer
tab, and let it show a few frames. Main writes what the VM's VNC server sent
(the first 32 MiB) to
`<userData>/bot-computers/rfb-recordings/<vm>-<time>.bin`, mode 0600. Those
transcripts use VNC auth, so their replay needs the security type 2 path:
copy one here, add a test that replays it with any password (the recorded
SecurityResult is replayed whatever the client answers), and check the
dimensions and pixel format it reports. Recordings show the guest's screen:
take them on a fresh Bot computer with nothing private on it.
