/** Public surface of the assignments module (stage 3): who holds which lead, assigned, sent, cancelled and moved by hand. */
export {
  createAssignmentService,
  type AssignmentFailure,
  type AssignmentResult,
  type AssignmentService,
  type AssignmentServiceDeps,
  type Candidates,
} from "./service";
export { buildHandoverMessage } from "./message";
export { activeAssignmentsForLead, commitExclusive, consentState, insertLeadEvent, insertRoutedAssignment, lockAssignment, lockLead, transitionAssignment, transitionLead, ACTIVE_STATUSES, type AssignmentHistoryEntry, type AssignmentRow, type AssignmentStatus, type LeadAssignmentView } from "./repo";
