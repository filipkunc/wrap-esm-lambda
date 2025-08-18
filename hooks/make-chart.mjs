import * as fs from "node:fs";
import Chart from "chart.js/auto";
import { Canvas } from 'skia-canvas';

let commands = [];
let times = [];
let memory = [];

/** @type { string[] } */
let benchTableLines = fs.readFileSync("benchTable.md", "utf-8").split("\n");
benchTableLines.splice(1, 1);
for (let i = 0; i < benchTableLines.length; ++i) {
  let entries = benchTableLines[i].split('|').slice(1, -1);
  for (let j = 0; j < entries.length; ++j) {
    entries[j] = entries[j].trim();
    if (entries[j].startsWith('`')) {
      entries[j] = entries[j].slice(1, -1);
    }
  }
  benchTableLines[i] = entries.join(',');
  if (i > 0 && benchTableLines[i].length > 0) {
    commands.push(entries[0].replace("runtime.mjs", "").replace("node --import", "").replace(".node node", ".node"));
    times.push(+(entries[1].split('±')[0]));
    memory.push(+entries[entries.length - 1]);
  }
}

const canvas = new Canvas(800, 500);
const chart = new Chart(
  canvas,
  {
    type: 'bar',
    data: {
      datasets: [{
        label: "Mean [ms]",
        data: times,
        borderWidth: 1
      }, {
        label: "Max RSS [MB]",
        data: memory,
        borderWidth: 1
      }],
      labels: commands
    },
    options: {
      indexAxis: 'y',
    }
  }
);
const pngBuffer = await canvas.toBuffer('png', { matte: 'white' });
fs.writeFileSync('benchChart.png', pngBuffer);
chart.destroy();
