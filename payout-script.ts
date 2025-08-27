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

interface EraStats {
  era: number;
  totalStake: number;
  totalValidatorReward: number;
  maxValidatorEarnings: number;
  minValidatorEarnings: number;
  avgValidatorEarnings: number;
  maxCommission: number;
  minCommission: number;
  validatorsPending: number;
  status: string;
}

async function sendSlackMessage(eraStats: EraStats[]): Promise<string | null> {
  try {
    // Create a formatted table header
    const header = [
      "*Era Stats Summary*\n",
      "```",
      "Era  | Total Stake | Validator Reward | Max Earnings | Min Earnings | Avg Earnings | Max Comm | Min Comm | Pending | Status",
      "-".repeat(100)
    ].join('\n');

    // Format each row of data
    const rows = eraStats.map(stat => {
      return [
        stat.era.toString().padEnd(5),
        Math.floor(stat.totalStake).toLocaleString().padEnd(12),
        Math.floor(stat.totalValidatorReward).toLocaleString().padEnd(17),
        Math.floor(stat.maxValidatorEarnings).toLocaleString().padEnd(13),
        Math.floor(stat.minValidatorEarnings).toLocaleString().padEnd(13),
        Math.floor(stat.avgValidatorEarnings).toLocaleString().padEnd(13),
        `${stat.maxCommission.toFixed(1)}%`.padEnd(10),
        `${stat.minCommission.toFixed(1)}%`.padEnd(10),
        stat.validatorsPending.toString().padEnd(9),
        stat.status
      ].join('| ');
    });

    const message = [header, ...rows, "```"].join('\n');

    const result = await slack.chat.postMessage({
      channel: config.channelId,
      text: message,
      mrkdwn: true
    });

    console.log('Summary sent to Slack:', result.ts);
    return null;
  } catch (error) {
    console.error('Error sending message to Slack:', error);
    return null;
  }
}

const main = async () => {
  const api = await initialize(config.endpoint)

  /* THINGS YOU CAN CHANGE */
  const account = getKeyringFromSeed(config.seed)
  const options = { app_id: 0, nonce: -1 }
  let validatorStashes: string[] = [];

  // Get the active era
  const activeEra = (await api.query.staking.currentEra()).toJSON() as number
  
  const startEra = activeEra-53
  const eraStats: EraStats[] = [];

  // Loop through each era
  for (let currentEra = startEra; currentEra <= activeEra-7; currentEra++) {
    console.log(`Processing era ${currentEra}...`);
    
    let toClaim: { era: number; validator: string }[] = [];
    
    // Get the validators who earned reward during this era
    const eraRewardPoints = (await api.query.staking.erasRewardPoints(currentEra)).toJSON() as {
      total: number
      individual: { [address: string]: number }
    }
    
    const erasTotalStake = Number((BigInt((await api.query.staking.erasTotalStake(currentEra)).toString().replace(/,/g, '')) / BigInt(10 ** 18)));
    const erasValidatorTotalReward = Number((BigInt((await api.query.staking.erasValidatorReward(currentEra)).toString().replace(/,/g, '')) / BigInt(10 ** 18)));

    const erasValidatorPrefs = (await api.query.staking.erasValidatorPrefs.entries(currentEra)).map(([key, value]) => {
      const keyHuman = key.toHuman() as [number, string];
      const [, individual] = keyHuman;
      const { commission, blocked } = value.toHuman() as Record<string, unknown>;
      return {
        individual,
        commission,
        blocked
      }
    })

    const erasStakersOverview = (await api.query.staking.erasStakersOverview.entries(currentEra)).map(([key, value]) => {
      
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

    const eraRewardPointsValidatorList = Object.keys(eraRewardPoints.individual)
    const claimedRewards = (await api.query.staking.claimedRewards.entries(currentEra)).map(
      (x) => (x[0].toHuman() as string[])[1],
    )

    let validatorsWithPendingClaim = eraRewardPointsValidatorList.filter((x) => !claimedRewards.includes(x))
    if (validatorStashes.length > 0) {
      validatorsWithPendingClaim = validatorsWithPendingClaim.filter((x) => validatorStashes.includes(x))
    }

    toClaim = [
      ...toClaim,
      ...validatorsWithPendingClaim.map((x) => {
        return { era: currentEra, validator: x }
      }),
    ]

    // Process payouts for the current era
    const transactions = await Promise.all(toClaim.map((x) => api.tx.staking.payoutStakers(x.validator, x.era)))
    const chunks = []
    const chunkSize = 20
    for (let i = 0; i < transactions.length; i += chunkSize) {
      const chunk = transactions.slice(i, i + chunkSize)
      chunks.push(chunk)
    }

    let eraStatus = 'Success';
    const batches = chunks.map((x) => api.tx.utility.batchAll(x))
    
    for (const [i, tx] of batches.entries()) {
      console.log(`Sending batch transaction ${i + 1} of ${batches.length} for era ${currentEra}`)
      
      const txResult = await new Promise<ISubmittableResult>((res) => {
        tx.signAndSend(account, options, (result) => {
          if (result.isInBlock || result.isError) {
            res(result as unknown as ISubmittableResult)
          }
        })
      })

      if (txResult.isError) {
        eraStatus = 'Failed';
        console.log(`Transaction failed for batch ${i + 1} in era ${currentEra}`);
      }
    }

    // Store era statistics
    eraStats.push({
      era: currentEra,
      totalStake: erasTotalStake,
      totalValidatorReward: erasValidatorTotalReward,
      maxValidatorEarnings: maxNetValidatorEarnings,
      minValidatorEarnings: minNetValidatorEarnings,
      avgValidatorEarnings: avgNetValidatorEarnings,
      maxCommission: maxCommission,
      minCommission: minCommission,
      validatorsPending: validatorsWithPendingClaim.length,
      status: eraStatus
    });
  }

  // Send final summary to Slack
  await sendSlackMessage(eraStats);
  // console.log(eraStats)

  console.log("All eras processed, disconnecting...")
  await disconnect()
  process.exit(0)
}

main()