use soroban_sdk::{contractimpl, panic_with_error, Address, Bytes, BytesN, Env, Vec};

use crate::errors::AdminError;
use crate::types::{AdminAction, DataKey, MultisigAction};

// Current layout version
const LAYOUT_VERSION: u32 = 1;

// ── Storage helpers ──────────────────────────────────────────────────────────

pub fn get_layout_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::LayoutVersion)
        .unwrap_or(0)
}

pub fn get_admins(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::Admins)
        .expect("admins not initialised")
}

pub fn get_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::Threshold)
        .expect("threshold not initialised")
}

fn get_nonce(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::Nonce)
        .unwrap_or(0u64)
}

fn increment_nonce(env: &Env) -> u64 {
    let next = get_nonce(env) + 1;
    env.storage().instance().set(&DataKey::Nonce, &next);
    next
}

// ── Action-hash derivation ───────────────────────────────────────────────────

/// Deterministic hash: sha256(nonce_le_bytes || action_tag_byte || action_payload)
/// The nonce prevents replay of an identical action that was previously rejected.
pub fn compute_action_hash(env: &Env, nonce: u64, action: &AdminAction) -> BytesN<32> {
    let mut preimage = Bytes::new(env);

    // 8-byte little-endian nonce
    preimage.extend_from_array(&nonce.to_le_bytes());

    // 1-byte discriminator + payload
    match action {
        AdminAction::RegisterTask(pr) => {
            preimage.push_back(0x01);
            preimage.extend_from_array(&pr.to_le_bytes());
        }
        AdminAction::PurgeTask(pr) => {
            preimage.push_back(0x02);
            preimage.extend_from_array(&pr.to_le_bytes());
        }
        AdminAction::UpdateThreshold(m) => {
            preimage.push_back(0x03);
            preimage.extend_from_array(&m.to_le_bytes());
        }
        AdminAction::UpdateAdmins(addrs) => {
            preimage.push_back(0x04);
            for addr in addrs.iter() {
                // Each Soroban Address serialises deterministically via its
                // underlying ScAddress XDR bytes.
                preimage.append(&addr.to_xdr(env));
            }
        }
    }

    env.crypto().sha256(&preimage)
}

// ── Core multisig logic ──────────────────────────────────────────────────────

/// Create a new proposal.  The caller must be a registered admin.
/// Returns the `action_hash` that identifies the proposal.
pub fn propose_action(env: &Env, proposer: &Address, action: AdminAction) -> BytesN<32> {
    proposer.require_auth();
    assert_is_admin(env, proposer);

    let nonce = get_nonce(env);
    let action_hash = compute_action_hash(env, nonce, &action);

    // Proposal must not already exist
    if env
        .storage()
        .instance()
        .has(&DataKey::Proposal(action_hash.clone()))
    {
        panic_with_error!(env, AdminError::ProposalAlreadyExists);
    }

    let mut approvals: Vec<Address> = Vec::new(env);
    approvals.push_back(proposer.clone()); // proposer auto-approves

    let proposal = MultisigAction {
        action,
        action_hash: action_hash.clone(),
        approvals,
        executed: false,
    };

    env.storage()
        .instance()
        .set(&DataKey::Proposal(action_hash.clone()), &proposal);

    action_hash
}

/// Cast an approval vote. Executes the action when M approvals are reached.
/// Returns `true` when the action was executed.
pub fn approve_action(env: &Env, approver: &Address, action_hash: BytesN<32>) -> bool {
    approver.require_auth();
    assert_is_admin(env, approver);

    let key = DataKey::Proposal(action_hash.clone());
    let mut proposal: MultisigAction = env
        .storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(env, AdminError::ProposalNotFound));

    if proposal.executed {
        panic_with_error!(env, AdminError::AlreadyExecuted);
    }

    // Idempotent: ignore duplicate votes from the same admin
    for existing in proposal.approvals.iter() {
        if existing == *approver {
            return false;
        }
    }

    proposal.approvals.push_back(approver.clone());

    let threshold = get_threshold(env);
    let executed = proposal.approvals.len() >= threshold;

    if executed {
        proposal.executed = true;
        execute_action(env, &proposal.action);
        increment_nonce(env);
    }

    env.storage().instance().set(&key, &proposal);
    executed
}

// ── Action execution ─────────────────────────────────────────────────────────

fn execute_action(env: &Env, action: &AdminAction) {
    match action {
        AdminAction::RegisterTask(pr) => {
            env.storage()
                .instance()
                .set(&DataKey::Task(*pr), &true);
        }
        AdminAction::PurgeTask(pr) => {
            env.storage()
                .instance()
                .remove(&DataKey::Task(*pr));
        }
        AdminAction::UpdateThreshold(m) => {
            let admins = get_admins(env);
            if *m == 0 || *m as usize > admins.len() as usize {
                panic_with_error!(env, AdminError::InvalidThreshold);
            }
            env.storage().instance().set(&DataKey::Threshold, m);
        }
        AdminAction::UpdateAdmins(new_admins) => {
            if new_admins.is_empty() {
                panic_with_error!(env, AdminError::EmptyAdminSet);
            }
            // Clamp threshold if needed to avoid > N
            let threshold = get_threshold(env);
            if threshold as usize > new_admins.len() as usize {
                env.storage()
                    .instance()
                    .set(&DataKey::Threshold, &(new_admins.len() as u32));
            }
            env.storage()
                .instance()
                .set(&DataKey::Admins, new_admins);
        }
    }
}

// ── Guard ────────────────────────────────────────────────────────────────────

pub fn assert_is_admin(env: &Env, addr: &Address) {
    let admins = get_admins(env);
    for a in admins.iter() {
        if a == *addr {
            return;
        }
    }
    panic_with_error!(env, AdminError::Unauthorized);
}

/// Initialise the contract. Can only be called once (no admins → bootstraps).
pub fn initialize(env: &Env, admins: Vec<Address>, threshold: u32) {
    if env.storage().instance().has(&DataKey::Admins) {
        panic_with_error!(env, AdminError::AlreadyInitialized);
    }
    if admins.is_empty() {
        panic_with_error!(env, AdminError::EmptyAdminSet);
    }
    if threshold == 0 || threshold as usize > admins.len() as usize {
        panic_with_error!(env, AdminError::InvalidThreshold);
    }
    env.storage().instance().set(&DataKey::LayoutVersion, &LAYOUT_VERSION);
    env.storage().instance().set(&DataKey::Admins, &admins);
    env.storage().instance().set(&DataKey::Threshold, &threshold);
    env.storage().instance().set(&DataKey::Nonce, &0u64);
}
