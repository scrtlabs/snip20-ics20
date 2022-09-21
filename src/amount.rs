use serde::{Deserialize, Serialize};

use cosmwasm_std::Uint128;

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct Snip20Coin {
    pub address: String,
    pub amount: Uint128,
}

impl Snip20Coin {
    pub fn from_parts(denom: String, amount: Uint128) -> Self {
        // if denom.starts_with("cw20:") {
        let address = denom.get(5..).unwrap().into();
        Snip20Coin { address, amount }
    }

    pub fn snip20(amount: u128, addr: &str) -> Self {
        Snip20Coin {
            address: addr.into(),
            amount: Uint128::new(amount),
        }
    }
}
