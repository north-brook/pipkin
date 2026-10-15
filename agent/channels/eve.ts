import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev } from "eve/channels/auth";

// The HTTP/TUI surface is for operators only: open on localhost during
// `eve dev`, and behind Basic auth when PIPKIN_ADMIN_PASSWORD is set so
// `eve remote connect` can reach a running host. GitHub traffic uses the
// github channel, which verifies webhook signatures instead.
const password = process.env.PIPKIN_ADMIN_PASSWORD;

export default eveChannel({
  auth: [localDev(), ...(password ? [httpBasic({ username: "pipkin", password })] : [])],
});
