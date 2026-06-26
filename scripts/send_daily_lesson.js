const fs = require('fs');
const path = require('path');
const https = require('https');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SYLLABUS_PATH = path.resolve(__dirname, '../syllabus.json');
const PROGRESS_PATH = path.resolve(__dirname, '../progress.json');

if (!WEBHOOK_URL) {
  console.error('DISCORD_WEBHOOK_URL not set!');
  process.exit(1);
}

const syllabus = JSON.parse(fs.readFileSync(SYLLABUS_PATH, 'utf8'));
const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));

const currentDay = progress.current_day;

let lesson = null;
let unitTitle = '';
let unitNumber = 1;

for (const unit of syllabus.units) {
  for (const day of unit.days) {
    if (day.day === currentDay) {
      lesson = day;
      unitTitle = unit.title;
      unitNumber = unit.unit;
      break;
    }
  }
  if (lesson) break;
}

if (!lesson) {
  console.log(`Course complete! All ${syllabus.total_days} days finished. Congratulations!`);
  process.exit(0);
}

function truncate(str, max = 1020) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

const vocabText = truncate(
  lesson.vocabulary.map(v => `**${v.word}** (${v.romanization}) — ${v.meaning}`).join('\n')
);

const examplesText = truncate(
  lesson.grammar.examples.map(e => `> ${e.korean}\n> _${e.meaning}_`).join('\n\n')
);

const homeworkText = truncate(
  lesson.homework.map((h, i) => `${i + 1}. ${h}`).join('\n')
);

const filled = Math.round((currentDay / syllabus.total_days) * 20);
const progressBar = '█'.repeat(filled) + '░'.repeat(20 - filled);

const embeds = [
  {
    title: `Day ${currentDay}/60 — ${lesson.topic}`,
    description: `**Unit ${unitNumber}: ${unitTitle}**\nProgress: \`${progressBar}\` ${currentDay}/${syllabus.total_days}\n_Study time: 15–20 minutes_`,
    color: 0x5B6BF5,
    fields: [
      { name: 'Vocabulary', value: vocabText, inline: false },
      { name: `Grammar: ${lesson.grammar.pattern}`, value: truncate(lesson.grammar.explanation), inline: false },
      { name: 'Examples', value: examplesText, inline: false }
    ]
  },
  {
    title: `Reading: ${lesson.reading.title}`,
    description: truncate(
      `**Korean:**\n${lesson.reading.text}\n\n**Translation:**\n_${lesson.reading.translation}_`,
      4096
    ),
    color: 0x57F287,
    fields: [
      { name: 'Homework', value: homeworkText, inline: false }
    ],
    footer: {
      text: `TOPIK 1 Study Plan • Day ${currentDay} of ${syllabus.total_days} • 화이팅!`
    }
  }
];

function sendWebhook(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  try {
    await sendWebhook({ embeds });

    const now = new Date().toISOString();
    if (!progress.started_date) progress.started_date = now;
    progress.last_sent = now;
    progress.current_day = currentDay + 1;

    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));

    console.log(`Day ${currentDay} sent! Topic: ${lesson.topic}`);
    console.log(`Next: Day ${currentDay + 1}`);

    if (currentDay >= syllabus.total_days) {
      console.log('All 60 days complete! Congratulations!');
    }
  } catch (err) {
    console.error('Failed to send lesson:', err.message);
    process.exit(1);
  }
}

main();
