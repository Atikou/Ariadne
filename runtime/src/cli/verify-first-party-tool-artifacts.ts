import {
  verifyFirstPartyToolArtifactManifest
} from '../composition/first-party-tools/FirstPartyToolArtifactAuthority.js';

const modules = verifyFirstPartyToolArtifactManifest();
process.stdout.write(
  `first-party-tool-artifacts: verified ${String(modules.length)} implementation modules\n`
);
