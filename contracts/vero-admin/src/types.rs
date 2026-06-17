use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Discriminator for each admin action that can be proposed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum AdminAction {
    RegisterTask(u64),    // github PR number
    PurgeTask(u64),
    UpdateThreshold(u32), // new M value
    UpdateAdmins(Vec<Address>),
}

/// A pending multi-sig proposal stored in contract instance storage.
///
/// `action_hash` is `sha256(nonce || abi-encoded action)` and acts as a
/// replay-prevention nonce anchor — once executed the nonce increments,
/// making every past hash invalid for future proposals.
#[contracttype]
#[derive(Clone, Debug)]
pub struct MultisigAction {
    pub action: AdminAction,
    /// sha256(nonce ++ canonical action bytes)
    pub action_hash: BytesN<32>,
    /// Addresses that have already approved this proposal.
    pub approvals: Vec<Address>,
    pub executed: bool,
}

/// Top-level storage keys for instance (persistent) storage.
#[contracttype]
pub enum DataKey {
    Admins,
    Threshold,
    Nonce,
    Proposal(BytesN<32>), // keyed by action_hash
    Task(u64),            // registered PR numbers
}
