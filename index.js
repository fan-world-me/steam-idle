const SteamUser = require("steam-user");
const client = new SteamUser();

client.logOn({
    accountName: process.env.STEAM_LOGIN,
    password: process.env.STEAM_PASSWORD
});

client.on("loggedOn", () => {
    console.log("Logged into Steam!");
    client.gamesPlayed([570]);
    console.log("Dota 2 started, hours are ticking...");
});

client.on("error", (err) => {
    console.error("Error:", err);
});