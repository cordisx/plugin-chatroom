// Explicit suite registration preserves discovery through node --test test/*.mjs.
import { registerAdmissionAuthorityTests } from './agent-session-controller/admission-authority.mjs';
import { registerApprovalDisposalTests } from './agent-session-controller/approval-disposal.mjs';
import { registerFailureMigrationTests } from './agent-session-controller/failure-migration.mjs';
import { agentSessionControllerHarness } from './agent-session-controller/harness.mjs';
import { registerProjectionReplayTests } from './agent-session-controller/projection-replay.mjs';

registerProjectionReplayTests(agentSessionControllerHarness);
registerAdmissionAuthorityTests(agentSessionControllerHarness);
registerFailureMigrationTests(agentSessionControllerHarness);
registerApprovalDisposalTests(agentSessionControllerHarness);
