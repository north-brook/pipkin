import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// pipkin's agents have no shell or file tools; reviewers work from context
// gathered over the GitHub API. A virtual filesystem keeps hosts free of
// Docker or VM requirements.
export const environment = JustBashSandbox.environment({ autoInstall: false });

export default defineSandbox(() => environment.open());
