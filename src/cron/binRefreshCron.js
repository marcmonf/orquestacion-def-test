// src/cron/binRefreshCron.js
/**
 * Revalida BINs más usados cada 4 h.
 * Pensado para ejecutarse con Render Cron (o similar).
 */
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const { lookupBin } = require('../services/binService');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 h

  const bins = await Transaction.distinct('bin', { createdAt: { $gte: cutoff } });
  for (const bin of bins) {
    try { await lookupBin(bin); }
    catch (e) { console.error('BIN refresh error', bin, e.message); }
  }

  // opcional: export CSV
  // const fs = require('fs');
  // const BinCache = require('../models/BinCache');
  // const all = await BinCache.find().lean();
  // fs.writeFileSync('/mnt/data/binlist.csv', JSON.stringify(all));

  console.log('BIN cache refresh done,', bins.length, 'bins.');
  process.exit(0);
})();
