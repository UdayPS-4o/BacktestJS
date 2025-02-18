// ---------------------------------------------------- 
// |                RUN STRATEGY HELPERS              |
// ---------------------------------------------------- 

// ---------------------------------------------------- 
// |                     GLOBALS                      |
// ---------------------------------------------------- 

// Define imports
import { realBuy, realSell, orderBook, allOrders, clearOrders, getCurrentWorth } from "./orders"
import { RunStrategy, BuySell, Candle, DataReturn, Worth, LooseObject } from "../infra/interfaces"
import { findCandleIndex, getDiffInDays, round, generatePermutations, calculateSharpeRatio } from "./parse"
import { getCandles, getCandleMetaData } from './prisma-historical-data'
const path = require('path')
import * as cliProgress from 'cli-progress'
import * as fs from 'fs'

// ---------------------------------------------------- 
// |                   FUNCTIONS                      |
// ---------------------------------------------------- 

export async function run(runParams: RunStrategy) {
    // Check to run in js or ts
    let isJS = false;
    const extension = path.extname(__filename);
    if (extension === ".js") isJS = true;

    // Set the paths based on the environment
    const strategyPath = isJS ? `./dist/strategies/${runParams.strategyName}.js` : `./src/strategies/${runParams.strategyName}.ts`;
    const importPath = isJS ? `./dist/strategies/${runParams.strategyName}` : `../strategies/${runParams.strategyName}`;

    // Validate strategy file exists
    if (!fs.existsSync(strategyPath)) {
        return { error: true, data: `${runParams.strategyName} file does not exist in the strategy folder \n\nYou must create a file with a name of ${runParams.strategyName}.ts or .js in the strategy folder` };
    }

    // Import strategy
    const strategy = await import(importPath);

    // Validate strategy function exists
    if (strategy[runParams.strategyName] === undefined) {
        return { error: true, data: `${runParams.strategyName} file does not have a function with the name of ${runParams.strategyName}, it is mandatory to export a function with this name for EX:\n\nexport async function ${runParams.strategyName}(bth: BTH) {}` };
    }

    // Define error handler
    let returnAnError = false;
    let returnError: DataReturn = { error: false, data: '' };

    // Find if need to run multi and get there permutations
    let multiSymbol = runParams.historicalMetaData.length > 1;
    let multiValue = false;
    let permutations = [{}];
    let permutationDataReturn = [];
    if (Object.keys(runParams.params).length !== 0) {
        for (const key in runParams.params) {
            if (typeof runParams.params[key] === 'string' && runParams.params[key].includes(",")) {
                multiValue = true;
                permutations = generatePermutations(runParams.params);
                break;
            }
        }
    }

    let bar;
    if (multiValue || multiSymbol) {
        // Create a progress bar
        bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        bar.start(permutations.length * runParams.historicalMetaData.length, 0);
    }

    for (let symbolCount = 0; symbolCount < runParams.historicalMetaData.length; symbolCount++) {
        // Get candles
        const candlesRequest = await getCandles(runParams.historicalMetaData[symbolCount]);
        if (candlesRequest.error) return candlesRequest;
        let candles: Candle[] = [];
        if (typeof candlesRequest.data !== 'string') candles = candlesRequest.data.candles;
        let numberOfCandles = 0;

        let assetAmounts: LooseObject = {};

        for (let permutationCount = 0; permutationCount < permutations.length; permutationCount++) {
            if (multiValue) runParams.params = permutations[permutationCount];

            let historicalMetaData;
            if (multiValue || multiSymbol) {
                if (multiSymbol || historicalMetaData === undefined) {
                    // Get candle metaData
                    const historicalMetaDataResults = await getCandleMetaData(runParams.historicalMetaData[symbolCount]);
                    if (historicalMetaDataResults.error) return historicalMetaDataResults;
                    historicalMetaData = historicalMetaDataResults.data;
                    if (multiSymbol && typeof (historicalMetaData) !== 'string') {
                        runParams.startTime = historicalMetaData.startTime;
                        runParams.endTime = historicalMetaData.endTime;
                    }
                }

                // Update the progress bar
                if (bar !== undefined) bar.increment();
            }

            // Create / clear order book and all orders
            orderBook.bought = false;
            orderBook.boughtLong = false;
            orderBook.boughtShort = false;
            orderBook.baseAmount = 0;
            orderBook.quoteAmount = runParams.startingAmount;
            orderBook.borrowedBaseAmount = 0;
            orderBook.fakeQuoteAmount = runParams.startingAmount;
            orderBook.preBoughtQuoteAmount = runParams.startingAmount;
            orderBook.stopLoss = 0;
            orderBook.takeProfit = 0;
            await clearOrders();

            // Define all current worths
            const allWorths: Worth[] = [];

            // Find where loop should start and end
            let candleIndexes = await findCandleIndex(candles, runParams.startTime, runParams.endTime);
            let candleIndex = candleIndexes.startIndex;
            const candleIndexEnd = candleIndexes.endIndex;
            let allCandles = candles.slice(candleIndex, candleIndexEnd);
            numberOfCandles = candleIndexEnd - candleIndex;

            // Define strategy run metaData
            const runMetaData = {
                highestAmount: runParams.startingAmount,
                highestAmountDate: candles[candleIndex].closeTime,
                lowestAmount: runParams.startingAmount,
                lowestAmountDate: candles[candleIndex].closeTime,
                maxDrawdownAmount: 0,
                maxDrawdownAmountDates: '',
                maxDrawdownPercent: 0,
                maxDrawdownPercentDates: '',
                startingAssetAmount: candles[candleIndex].close,
                startingAssetAmountDate: candles[candleIndex].closeTime,
                endingAssetAmount: candles[candleIndexEnd].close,
                endingAssetAmountDate: candles[candleIndexEnd].closeTime,
                highestAssetAmount: candles[candleIndex].high,
                highestAssetAmountDate: candles[candleIndex].closeTime,
                lowestAssetAmount: candles[candleIndex].low,
                lowestAssetAmountDate: candles[candleIndex].closeTime,
                numberOfCandles,
                numberOfCandlesInvested: 0,
                sharpeRatio: 0
            };

            // Variables to track max drawdown
            let highestPeak = runParams.startingAmount;
            let maxDrawdownAmount = 0;
            let maxDrawdownPercent = 0;
            let maxDrawdownDates = '';

            // ---------------------------------------------------- 
            // |                  START FOR LOOP                  |
            // ---------------------------------------------------- 
            for (candleIndex; candleIndex < candleIndexEnd; candleIndex++) {
                // Define current candle
                const currentCandle = candles[candleIndex];

                // Define if can buy or sell based on getCandles decision
                let canBuySell = true;

                // Buy function that calls the real one
                async function buy(buyParams?: BuySell) {
                    // Dont allow buy if highest needed candle is not met
                    if (!canBuySell) return { error: false, data: 'Buy blocked until highest needed candles are met' };

                    // Define buy price if needed
                    if (buyParams === undefined) buyParams = {};
                    if (buyParams.price === undefined) buyParams.price = currentCandle.close;

                    // Create the real buy params
                    const buyParamsReal = {
                        ...buyParams,
                        currentClose: currentCandle.close,
                        percentFee: runParams.percentFee,
                        percentSlippage: runParams.percentSlippage,
                        date: currentCandle.closeTime
                    };

                    // Check stop loss is not set with long and short
                    if (buyParams.stopLoss !== undefined && buyParams.stopLoss > 0 && orderBook.borrowedBaseAmount > 0 && orderBook.baseAmount > 0) {
                        returnAnError = true;
                        returnError = { error: true, data: 'Cannot define a stop loss if in a long and a short' };
                    }

                    // Check take profit is not set with long and short
                    if (buyParams.takeProfit !== undefined && buyParams.takeProfit > 0 && orderBook.borrowedBaseAmount > 0 && orderBook.baseAmount > 0) {
                        returnAnError = true;
                        returnError = { error: true, data: 'Cannot define a take profit if in a long and a short' };
                    }

                    // Set stop loss and take profit
                    if (buyParams.stopLoss !== undefined && buyParams.stopLoss > 0) orderBook.stopLoss = buyParams.stopLoss;
                    if (buyParams.takeProfit !== undefined && buyParams.takeProfit > 0) orderBook.takeProfit = buyParams.takeProfit;

                    // Perform the buy
                    const buyResults = await realBuy(buyParamsReal);

                    // Handle if buying error
                    if (buyResults?.error) {
                        returnAnError = true;
                        returnError = buyResults;
                    }
                }

                // Sell function that call the real one
                async function sell(sellParams?: BuySell) {
                    // Dont allow sell if highest needed candle is not met
                    if (!canBuySell) return { error: false, data: 'Sell blocked until highest needed candles are met' };

                    // Define sell price if needed
                    if (sellParams === undefined) sellParams = {};
                    if (sellParams.price === undefined) sellParams.price = currentCandle.close;

                    // Create the real sell params
                    const sellParamsReal = {
                        ...sellParams,
                        currentClose: currentCandle.close,
                        percentFee: runParams.percentFee,
                        percentSlippage: runParams.percentSlippage,
                        date: currentCandle.closeTime
                    };

                    // Perform the sell
                    const sellResults = await realSell(sellParamsReal);

                    // Handle if selling error
                    if (sellResults?.error) {
                        returnAnError = true;
                        returnError = sellResults;
                    }
                }

                // Get candle data
                async function getCandles(type: keyof Candle | 'all', start: number, end?: number) {
                    // Check if candle start time is valid
                    const candleCheck = end === undefined ? start : end;

                    // If highest needed candles is not met, return 0 or array of 0's and disable buy and sells
                    if (candleIndex - candleCheck < 0) {
                        canBuySell = false;
                        return end === undefined ? 0 : new Array(end - start).fill(0);
                    }

                    // Allow buy and sells if set to false previously
                    canBuySell = true;

                    // Return a single value
                    if (end === undefined) return type === 'all' ? candles[candleIndex - start] : candles[candleIndex - start][type];

                    // Return all properties of each candle in the range when type is all
                    if (type === 'all') return candles.slice(candleIndex - end, candleIndex - start);

                    // Return a specific type of each candle in the range
                    return candles.slice(candleIndex - end, candleIndex - start).map(candle => candle[type]);
                }

                // Return an error before running if needed 
                if (returnAnError) return returnError;

                // Check stop loss
                if (orderBook.stopLoss > 0) {
                    // Long stop loss check
                    if (orderBook.baseAmount > 0) {
                        if (currentCandle.low <= orderBook.stopLoss) await sell({ price: orderBook.stopLoss });
                    }

                    // Short stop loss check
                    else if (orderBook.borrowedBaseAmount > 0) {
                        if (currentCandle.high >= orderBook.stopLoss) await sell({ price: orderBook.stopLoss });
                    }
                }

                // Check take profit
                if (orderBook.takeProfit > 0) {
                    // Long take profit check
                    if (orderBook.baseAmount > 0) {
                        if (currentCandle.high >= orderBook.takeProfit) await sell({ price: orderBook.takeProfit });
                    }

                    // Short take profit check
                    else if (orderBook.borrowedBaseAmount > 0) {
                        if (currentCandle.low <= orderBook.takeProfit) await sell({ price: orderBook.takeProfit });
                    }
                }

                // Get current worth and check if error
                const worth = await getCurrentWorth(currentCandle.close, currentCandle.high, currentCandle.low, currentCandle.open);
                if (worth.low <= 0) return {
                    error: true,
                    data: `Your worth in this candle went to 0 or less than 0, it is suggested to handle shorts with stop losses, Lowest worth this candle: ${worth.low}, Date: ${new Date(currentCandle.closeTime).toLocaleString()}`
                };

                // Push in worth to all worths
                allWorths.push({ close: worth.close, high: worth.high, low: worth.low, open: worth.open, time: currentCandle.closeTime });

                // Update asset amount
                if (currentCandle.high > runMetaData.highestAssetAmount) {
                    runMetaData.highestAssetAmount = currentCandle.high;
                    runMetaData.highestAssetAmountDate = currentCandle.closeTime;
                }
                if (currentCandle.low < runMetaData.lowestAssetAmount) {
                    runMetaData.lowestAssetAmount = currentCandle.low;
                    runMetaData.lowestAssetAmountDate = currentCandle.closeTime;
                }

                // Update metaData worths and drawdowns
                if (worth.high > highestPeak) {
                    highestPeak = worth.high;
                }

                // Calculate current drawdown
                const currentDrawdownAmount = highestPeak - worth.low;
                const currentDrawdownPercent = (currentDrawdownAmount / highestPeak) * 100;

                // Update max drawdown if current drawdown is larger
                if (currentDrawdownAmount > maxDrawdownAmount) {
                    maxDrawdownAmount = currentDrawdownAmount;
                    maxDrawdownPercent = currentDrawdownPercent;
                    maxDrawdownDates = `${new Date(runMetaData.highestAmountDate).toLocaleString()} - ${new Date(currentCandle.closeTime).toLocaleString()} : ${getDiffInDays(runMetaData.highestAmountDate, currentCandle.closeTime)}`;
                }

                // Update runMetaData with max drawdown values
                runMetaData.maxDrawdownAmount = round(maxDrawdownAmount);
                runMetaData.maxDrawdownPercent = round(maxDrawdownPercent);
                runMetaData.maxDrawdownAmountDates = maxDrawdownDates;
                runMetaData.maxDrawdownPercentDates = maxDrawdownDates;

                // Call users strategy
                try {
                    await strategy[runParams.strategyName]({
                        currentCandle,
                        getCandles,
                        params: runParams.params,
                        orderBook,
                        buy,
                        sell
                    });
                } catch (error) {
                    return { error: true, data: `Ran into an error running the strategy with error ${error}` };
                }

                // Return an error after running if needed
                if (returnAnError) return returnError;

                // Update number of candles invested
                if (orderBook.bought) runMetaData.numberOfCandlesInvested++;

                // Sell if bought into and on last candle
                if (candleIndex === candleIndexEnd - 1 && orderBook.bought) await sell();
            }

            // Get the sharpe ratio
            runMetaData.sharpeRatio = calculateSharpeRatio(allWorths);

            if (multiValue || multiSymbol) {
                // Update asset amounts
                assetAmounts.startingAssetAmount = runMetaData.startingAssetAmount;
                assetAmounts.endingAssetAmount = runMetaData.endingAssetAmount;
                assetAmounts.highestAssetAmount = runMetaData.highestAssetAmount;
                assetAmounts.highestAssetAmountDate = runMetaData.highestAssetAmountDate;
                assetAmounts.lowestAssetAmount = runMetaData.lowestAssetAmount;
                assetAmounts.lowestAssetAmountDate = runMetaData.lowestAssetAmountDate;
                assetAmounts.numberOfCandles = numberOfCandles;

                // Push in relevant return data if multi value
                if (historicalMetaData !== undefined && typeof historicalMetaData !== 'string') {
                    permutationDataReturn.push({
                        ...runParams.params,
                        symbol: historicalMetaData.symbol,
                        interval: historicalMetaData.interval,
                        endAmount: allWorths[allWorths.length - 1].close,
                        maxDrawdownAmount: runMetaData.maxDrawdownAmount,
                        maxDrawdownPercent: runMetaData.maxDrawdownPercent,
                        numberOfCandlesInvested: runMetaData.numberOfCandlesInvested,
                        sharpeRatio: runMetaData.sharpeRatio,
                        assetAmounts
                    });
                }
            } else {
                // Return the runs data
                return { error: false, data: { allOrders, runMetaData, allWorths, allCandles } };
            }
        }
    }
    // Stop the progress bar if needed
    if (bar !== undefined) bar.stop();

    // Return the multi value data
    return { error: false, data: { permutationDataReturn } };
}