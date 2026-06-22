#![no_std]

mod admin;
mod errors;
mod types;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Vec};

use admin::{approve_action, assert_is_admin, get_admins, get_layout_version, get_threshold, initialize, propose_action};
use errors::AdminError;
use types::AdminAction;

pub use errors::AdminError as VeroAdminError;

#[contract]
pub struct VeroAdminContract;

#[contractimpl]
impl VeroAdminContract {
    /// One-time bootstrap. Sets the admin set and the M-of-N threshold.
    ///
    /// * `admins`    – ordered list of N authorised signers.
    /// * `threshold` – minimum approvals (M) required to execute an action.
    ///
    /// Panics with `AlreadyInitialized` if called more than once.
    pub fn initialize(env: Env, admins: Vec<Address>, threshold: u32) {
        initialize(&env, admins, threshold);
    }

    // ── Read helpers ─────────────────────────────────────────────────────────

    pub fn get_layout_version(env: Env) -> u32 {
        get_layout_version(&env)
    }

    pub fn get_admins(env: Env) -> Vec<Address> {
        get_admins(&env)
    }

    pub fn get_threshold(env: Env) -> u32 {
        get_threshold(&env)
    }

    // ── Multisig flow ─────────────────────────────────────────────────────────

    /// Propose registering a GitHub PR number on-chain.
    /// Single-signer call always reverts — the returned hash must collect M approvals.
    pub fn propose_register_task(env: Env, proposer: Address, pr: u64) -> BytesN<32> {
        propose_action(&env, &proposer, AdminAction::RegisterTask(pr))
    }

    /// Propose purging an existing task.
    pub fn propose_purge_task(env: Env, proposer: Address, pr: u64) -> BytesN<32> {
        propose_action(&env, &proposer, AdminAction::PurgeTask(pr))
    }

    /// Propose updating the approval threshold.
    pub fn propose_update_threshold(env: Env, proposer: Address, new_m: u32) -> BytesN<32> {
        propose_action(&env, &proposer, AdminAction::UpdateThreshold(new_m))
    }

    /// Propose replacing the admin set entirely.
    pub fn propose_update_admins(env: Env, proposer: Address, new_admins: Vec<Address>) -> BytesN<32> {
        propose_action(&env, &proposer, AdminAction::UpdateAdmins(new_admins))
    }

    /// Cast an approval vote on an existing proposal identified by `action_hash`.
    /// Executes the action immediately when the M threshold is reached.
    /// Returns `true` if the action was executed on this call.
    pub fn approve(env: Env, approver: Address, action_hash: BytesN<32>) -> bool {
        approve_action(&env, &approver, action_hash)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation},
        Address, Env, Vec,
    };

    fn setup(threshold: u32, n: usize) -> (Env, VeroAdminContractClient<'static>, Vec<Address>) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, VeroAdminContract);
        let client = VeroAdminContractClient::new(&env, &contract_id);

        let mut admins: Vec<Address> = Vec::new(&env);
        for _ in 0..n {
            admins.push_back(Address::generate(&env));
        }

        client.initialize(&admins, &threshold);
        (env, client, admins)
    }

    // ── Unauthorized single-signer ───────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn single_signer_cannot_execute_directly() {
        let (env, client, _admins) = setup(2, 3);
        let rogue = Address::generate(&env);
        // Rogue is not in the admin set → must panic with Unauthorized
        client.propose_register_task(&rogue, &42u64);
    }

    // ── Partial approval (M not yet reached) ────────────────────────────────

    #[test]
    fn partial_approval_does_not_execute() {
        // M=2, N=3.  First admin proposes (counts as 1 approval).
        // Second admin approves → threshold hit → executes.
        // But here we only test the *first* admin acting alone.
        let (env, client, admins) = setup(2, 3);

        let hash = client.propose_register_task(&admins.get(0).unwrap(), &99u64);
        // Proposal exists but execution threshold not reached yet
        let executed = client.approve(&admins.get(0).unwrap(), &hash);
        // Proposer already voted — duplicate vote is silently ignored (returns false)
        assert!(!executed, "duplicate vote must not trigger execution");
    }

    // ── Threshold-met: executes on the M-th approval ────────────────────────

    #[test]
    fn threshold_met_executes_action() {
        // M=2, N=3
        let (env, client, admins) = setup(2, 3);

        let hash = client.propose_register_task(&admins.get(0).unwrap(), &42u64);
        // Second unique admin casts the deciding vote
        let executed = client.approve(&admins.get(1).unwrap(), &hash);
        assert!(executed, "action must be executed on the M-th approval");
    }

    // ── Over-threshold: votes beyond M are accepted but action already done ──

    #[test]
    #[should_panic(expected = "AlreadyExecuted")]
    fn over_threshold_vote_on_executed_proposal_panics() {
        let (env, client, admins) = setup(2, 3);

        let hash = client.propose_register_task(&admins.get(0).unwrap(), &7u64);
        client.approve(&admins.get(1).unwrap(), &hash); // executes
        // Third admin tries to vote on an already-executed proposal
        client.approve(&admins.get(2).unwrap(), &hash);
    }

    // ── Nonce increments after execution (replay prevention) ────────────────

    #[test]
    fn nonce_increments_after_execution_preventing_replay() {
        let (env, client, admins) = setup(2, 3);

        // Execute one proposal
        let hash1 = client.propose_register_task(&admins.get(0).unwrap(), &1u64);
        client.approve(&admins.get(1).unwrap(), &hash1);

        // The *same* action with the new nonce produces a different hash
        let hash2 = client.propose_register_task(&admins.get(0).unwrap(), &1u64);
        assert_ne!(hash1, hash2, "nonce must differ across proposals");
    }

    // ── update_threshold via multisig ────────────────────────────────────────

    #[test]
    fn update_threshold_via_multisig() {
        let (env, client, admins) = setup(2, 3);

        let hash = client.propose_update_threshold(&admins.get(0).unwrap(), &3u32);
        let executed = client.approve(&admins.get(1).unwrap(), &hash);
        assert!(executed);
        assert_eq!(client.get_threshold(), 3);
    }

    // ── Non-admin cannot propose ─────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn non_admin_propose_panics() {
        let (env, client, _admins) = setup(2, 3);
        let outsider = Address::generate(&env);
        client.propose_register_task(&outsider, &55u64);
    }

    #[test]
    fn layout_version_is_set_correctly() {
        let (env, client, _admins) = setup(2, 3);
        // Layout version should be 1
        assert_eq!(client.get_layout_version(), 1);
    }
}
