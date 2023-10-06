use cosmwasm_std::{
    entry_point, from_binary, to_binary, Addr, Binary, Deps, DepsMut, Env, IbcMsg, MessageInfo,
    Response, StdResult, SubMsg, Uint128,
};

use crate::error::ContractError;
use crate::ibc::Ics20Packet;
use crate::msg::{ExecuteMsg, InitMsg, QueryMsg, Snip20Data, Snip20ReceiveMsg, TransferMsg};
use secret_toolkit::snip20;

use crate::state::{increase_channel_balance, CHANNEL_INFO, CODE_HASH};

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    mut _deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: InitMsg,
) -> Result<Response, ContractError> {
    Ok(Response::default())
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Receive(msg) => execute_receive(deps, env, info, msg),
        ExecuteMsg::RegisterTokens { tokens } => {
            let output_msgs = register_tokens(deps, env, tokens)?;

            Ok(Response::new().add_submessages(output_msgs))
        }
    }
}

pub fn execute_receive(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    wrapper: Snip20ReceiveMsg,
) -> Result<Response, ContractError> {
    let transfer_msg: TransferMsg;
    if let Some(msg_bytes) = wrapper.msg {
        transfer_msg = from_binary(&msg_bytes)?;
    } else {
        return Err(ContractError::MissingTransferMsg {});
    }

    let api = deps.api;
    execute_ibc_transfer(
        deps,
        env,
        transfer_msg,
        info.sender,
        wrapper.amount,
        api.addr_validate(&wrapper.sender)?,
    )
}

pub fn execute_ibc_transfer(
    deps: DepsMut,
    env: Env,
    msg: TransferMsg,
    token_address: Addr,
    amount: Uint128,
    sender: Addr,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::NoFunds {});
    }
    // ensure the requested channel is registered
    if !CHANNEL_INFO.has(deps.storage, &msg.channel) {
        return Err(ContractError::NoSuchChannel { id: msg.channel });
    }

    // Absolute timeout is in unix epoch
    let timeout = env.block.time.plus_seconds(msg.timeout);

    // build ics20 packet
    let packet = Ics20Packet::new(
        amount,
        format!("cw20:{}", token_address),
        sender.as_ref(),
        &msg.remote_address,
        &msg.memo,
    );
    packet.validate()?;

    // Update the balance now (optimistically) like ibctransfer modules.
    // In on_packet_failure (ack with error message or a timeout), we reduce the balance appropriately.
    // This means the channel works fine if success acks are not relayed.
    increase_channel_balance(deps.storage, &msg.channel, token_address.as_str(), amount)?;

    // send response
    let res = Response::new()
        .add_message(IbcMsg::SendPacket {
            channel_id: msg.channel,
            data: to_binary(&packet)?,
            timeout: timeout.into(),
        })
        .add_attribute("action", "transfer")
        .add_attribute("sender", &packet.sender)
        .add_attribute("receiver", &packet.receiver)
        .add_attribute("denom", &packet.denom)
        .add_attribute("amount", &packet.amount.to_string());
    Ok(res)
}

fn register_tokens(deps: DepsMut, env: Env, tokens: Vec<Snip20Data>) -> StdResult<Vec<SubMsg>> {
    let mut output_msgs = vec![];

    for token in tokens {
        let token_address = token.address;
        let token_code_hash = token.code_hash;

        CODE_HASH.save(
            deps.storage,
            deps.api.addr_validate(&token_address)?,
            &token_code_hash,
        )?;

        output_msgs.push(SubMsg::new(snip20::register_receive_msg(
            env.contract.code_hash.clone(),
            None,
            256,
            token_code_hash.clone(),
            token_address.clone(),
        )?));
        output_msgs.push(SubMsg::new(snip20::set_viewing_key_msg(
            "SNIP20-ICS20".into(),
            None,
            256,
            token_code_hash.clone(),
            token_address.clone(),
        )?));
    }

    Ok(output_msgs)
}

#[entry_point]
pub fn query(_deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {}
}
