import * as fs from "node:fs";

const benchTableLines = fs.readFileSync("benchTable.md", "utf-8").split("\n");
const files = fs.readdirSync(".").filter(x => x.match(/time_[a-z_]+\.txt/));
if (!benchTableLines[0].includes("Max RSS [MB]")) {
  benchTableLines[0] += " Max RSS [MB] |";
  benchTableLines[1] += "---:|";
  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const command = content.match(/Command being timed: "(.+)"/)[1];
    const maxRss = content.match(/Maximum resident set size \(kbytes\): ([0-9]+)/)[1];
    const index = benchTableLines.findIndex(x => x.includes(command));
    benchTableLines[index] += ` ${(maxRss / 1024).toFixed(2)} |`;
  }
  fs.writeFileSync("benchTable.md", benchTableLines.join("\n"), "utf-8");
}
