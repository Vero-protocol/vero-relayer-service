use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum AdminError {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    EmptyAdminSet = 3,
    InvalidThreshold = 4,
    ProposalNotFound = 5,
    ProposalAlreadyExists = 6,
    AlreadyExecuted = 7,
}
