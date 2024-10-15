import { ISubmittableResult } from "@polkadot/types/types"
import { H256 } from "@polkadot/types/interfaces/runtime"
import { getKeyringFromSeed, initialize, disconnect } from "avail-js-sdk"
import 'dotenv/config';
import { config } from "./config.js";
import { WebClient } from '@slack/web-api';


/**
 * Script to automate payouts.
 */
const slack = new WebClient(config.oathToken);
async function sendSlackMessage(message: string): Promise<string | null> {
  try {
    const result = await slack.chat.postMessage({
      channel: config.channelId,
      text: message,
      mrkdwn: true // Enable Markdown-like formatting
    });

    console.log('Message sent to Slack:', result.ts);
    return null;
  } catch (error) {
    console.error('Error sending message to Slack:', error);
    return null;
  }
}
const main = async () => {

  const api = await initialize(config.endpoint)

  /* THINGS YOU CAN CHANGE */
  // The account you'll do the payout with
  const account = getKeyringFromSeed(config.seed)
  const options = { app_id: 0, nonce: -1 }

  // Put the list of validators you want to do the payout for, leave empty for all of them
  let validatorStashes: string[] = [];

  // Get the active era
  const activeEra = (await api.query.staking.currentEra()).toJSON() as number

  const startEra = activeEra-7
  // We set a list of eras and validators to claim for
  let toClaim: { era: number; validator: string }[] = []

  let i = startEra;
  // We get the validators who earned reward during this era
  const eraRewardPoints = (await api.query.staking.erasRewardPoints(i)).toJSON() as {
    total: number
    individual: { [address: string]: number }
  }
  
  //Total Stake
  const erasTotalStake = Number((BigInt((await api.query.staking.erasTotalStake(i)).toString().replace(/,/g, '')) / BigInt(10 ** 18)));

  //Validator Total Reward
  const erasValidatorTotalReward = Number((BigInt((await api.query.staking.erasValidatorReward(i)).toString().replace(/,/g, '')) / BigInt(10 ** 18)));

  const erasValidatorPrefs = (await api.query.staking.erasValidatorPrefs.entries(i)).map(([key, value]) => {
    const keyHuman = key.toHuman() as [number, string];
    const [, individual] = keyHuman;
    const { commission, blocked } = value.toHuman() as Record<string, unknown>;
    return {
      individual,
      commission,
      blocked
    }
  })

  // We get the overview of the stakers for this era
  const erasStakersOverview = (await api.query.staking.erasStakersOverview.entries(i)).map(([key, value]) => {
    const keyHuman = key.toHuman() as [string, string];
    const [, individual] = keyHuman;
    const { total, own, nominatorCount, pageCount } = value.toHuman() as Record<string, string>;

    const validatorPref = erasValidatorPrefs.find(x => x.individual === individual);
    const rewardPoints = eraRewardPoints.individual[individual] || 0;
    const pointShare = rewardPoints / eraRewardPoints.total;


    const totalStake = Number((BigInt(total.replace(/,/g, '')) / BigInt(10 ** 18))).toFixed(2);
    const ownStake = Number((BigInt(own.replace(/,/g, '')) / BigInt(10 ** 18))).toFixed(2);


    const totalValidatorReward = Number(erasValidatorTotalReward) * pointShare;


    const commissionDecimal = Number((validatorPref?.commission as string | undefined)?.replace('%', '')) / 100 || 0;



    // Calculate ownReward and commissionEarned
    const commissionEarned = Number(totalValidatorReward * commissionDecimal);
    const ownReward = Number(totalValidatorReward - commissionEarned) * Number(ownStake) / Number(totalStake);

    const validatorEarnings = commissionEarned + ownReward;

    return {
      individual,
      total: totalStake,
      own: ownStake,
      commission: commissionDecimal.toFixed(2),
      blocked: validatorPref?.blocked ?? false,
      nominatorCount,
      pageCount,
      rewardPoints,
      pointShare: pointShare.toFixed(4),
      TotalValidatorEarnings: totalValidatorReward,
      NetValidatorEarnings: validatorEarnings,
      ownReward: ownReward,
      commissionEarned: commissionEarned
    };
  });

  // Calculate statistics
  const maxNetValidatorEarnings = Math.max(...erasStakersOverview.map(v => (v.NetValidatorEarnings)));
  const minNetValidatorEarnings = Math.min(...erasStakersOverview.map(v => (v.NetValidatorEarnings)));
  const avgNetValidatorEarnings = erasStakersOverview.reduce((sum, v) => sum + (v.NetValidatorEarnings), 0) / erasStakersOverview.length;

  const maxCommission = Math.max(...erasStakersOverview.map(v => Number(v.commission) * 100));
  const minCommission = Math.min(...erasStakersOverview.map(v => Number(v.commission) * 100));


  // Log the requested data
  console.log(`
    1. Current Era: ${i}
    2. Total Stake: ${new Intl.NumberFormat('en-US').format(Number(erasTotalStake))}
    3. Total Validator Reward across the Network: ${new Intl.NumberFormat('en-US').format(Number(erasValidatorTotalReward))}
    4. Maximum Net Validator Earnings: ${new Intl.NumberFormat('en-US').format(Number(maxNetValidatorEarnings))}
    5. Minimum Net Validator Earnings: ${new Intl.NumberFormat('en-US').format(Number(minNetValidatorEarnings))}
    6. Average Net Validator Earnings: ${new Intl.NumberFormat('en-US').format(Number(avgNetValidatorEarnings))}
    7. Maximum Commission: ${maxCommission.toFixed(2)}%
    8. Minimum Commission: ${minCommission.toFixed(2)}%
    `);
  const message = `
      *Payout Details*
      1. Era: ${i}
      2. Total Stake: ${new Intl.NumberFormat('en-US').format(Number(erasTotalStake))}
      3. Total Validator Reward across the Network: ${new Intl.NumberFormat('en-US').format(Number(erasValidatorTotalReward))}
      4. Maximum Net Validator Earnings: ${new Intl.NumberFormat('en-US').format(Number(maxNetValidatorEarnings))}
      5. Minimum Net Validator Earnings: ${new Intl.NumberFormat('en-US').format(Number(minNetValidatorEarnings))}
      6. Average Net Validator Earnings: ${new Intl.NumberFormat('en-US').format(Number(avgNetValidatorEarnings))}
      7. Maximum Commission: ${maxCommission.toFixed(2)}%
      8. Minimum Commission: ${minCommission.toFixed(2)}%
      `;
  // await sendSlackMessage(message)



  const eraRewardPointsValidatorList = Object.keys(eraRewardPoints.individual)

  // We get the validators where the payout has already been done for this era
  const claimedRewards = (await api.query.staking.claimedRewards.entries(i)).map(
    (x) => (x[0].toHuman() as string[])[1],
  )

  // We get all validator WITH eraRewardPoints and WITHOUT already claimed reward
  let validatorsWithPendingClaim = eraRewardPointsValidatorList.filter((x) => !claimedRewards.includes(x))

  // We filter by the specified stashes if there are any
  if (validatorStashes.length > 0) {
    validatorsWithPendingClaim = validatorsWithPendingClaim.filter((x) => validatorStashes.includes(x))
  }

  // We update the global list
  toClaim = [
    ...toClaim,
    ...validatorsWithPendingClaim.map((x) => {
      return { era: i, validator: x }
    }),
  ]
  console.log(`Found ${validatorsWithPendingClaim.length} validators with pending claims for era ${i}`)
  // await sendSlackMessage(`Found ${validatorsWithPendingClaim.length} validators with pending claims for era ${i}`)

  // We create all the transactions
  const transactions = await Promise.all(toClaim.map((x) => api.tx.staking.payoutStakers(x.validator, x.era)))
  const chunks = []
  const chunkSize = 5
  for (let i = 0; i < transactions.length; i += chunkSize) {
    const chunk = transactions.slice(i, i + chunkSize)
    chunks.push(chunk)
  }

  // We batch them together
  const batches = chunks.map((x) => api.tx.utility.batchAll(x))
  // await sendSlackMessage('Sending payout batch transactions')
  for (const [i, tx] of batches.entries()) {
    console.log(`Sending batch transaction ${i + 1} of ${batches.length}`)
    // Send the batch
    const txResult = await new Promise<ISubmittableResult>((res) => {
      tx.signAndSend(account, options, (result) => {
        if (result.isInBlock || result.isError) {
          res(result as unknown as ISubmittableResult)
        }
      })
    })

    // Error handling
    if (!txResult.isError) {
      console.log(`Payout done successfully for batch transaction ${i + 1} of ${batches.length} `)

      console.log(`Tx Hash: ${txResult.txHash as H256}, Block Hash: ${txResult.status.asInBlock as H256}`)

    } else {
      console.log(`Transaction was not executed for batch transaction ${i + 1} of ${batches.length}`)
    }
  }
  // await sendSlackMessage('Payout done successfully!')
  console.log("Everything was done, bye !")
  await disconnect()
  process.exit(0)
}
main()