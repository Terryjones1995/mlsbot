# Discord Bot

A Discord bot built with Node.js, Discord.js, and Firebase that automates server tasks, manages channels, and integrates with a Firebase database.

## Features

* Responds to slash commands and prefix-based commands
* Creates and manages teams, rosters, and matchmaking
* Logs events and persists data in Firebase
* Configurable category and guild IDs
* Easy-to-extend command and event handler structure

## Prerequisites

* Node.js v16 or higher
* A Discord account and server with Developer Mode enabled
* A Firebase project with a Service Account key
* Git (optional)

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/your-username/your-bot-repo.git
cd your-bot-repo
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the `.env` file

In the project root, create a file named `.env` and add the following variables:

```dotenv
# Discord credentials
DISCORD_TOKEN=your-bot-token-here       # Bot token from Discord Developer Portal
DISCORD_CLIENT_ID=your-client-id-here   # Application (Client) ID
DISCORD_GUILD_ID=your-guild-id-here     # ID of the server where you’ll test/register commands
CATEGORY_ID=your-category-id-here       # ID of the Discord category for bot channels

# Firebase credentials (Option A: path to JSON file)
FIREBASE_SERVICE_ACCOUNT_KEY_PATH=./serviceAccountKey.json
FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com

# Or Option B: individual keys (paste the JSON values directly)
# FIREBASE_PROJECT_ID=your-project-id
# FIREBASE_CLIENT_EMAIL=your-client-email@your-project-id.iam.gserviceaccount.com
# FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
# FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com
```

#### How to get your Discord Bot credentials

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, name it and click **Create**.
3. In the sidebar, select **Bot** → **Add Bot** → **Yes, do it!**
4. Under **Token**, click **Copy** and paste it into `DISCORD_TOKEN`.
5. Under **OAuth2** → **General**, copy the **Client ID** to `DISCORD_CLIENT_ID`.
6. Invite the bot to your server:

   * Under **OAuth2** → **URL Generator**, select `bot` and `applications.commands` scopes.
   * Choose required permissions (e.g., Manage Channels, Send Messages).
   * Copy the generated URL, open it in your browser, and invite the bot.
7. In Discord, enable **Developer Mode** (User Settings → Advanced → Developer Mode).
8. Right-click your server icon and click **Copy ID** to get `DISCORD_GUILD_ID`.
9. Create a category in your server, right-click the category and **Copy ID** to set `CATEGORY_ID`.

#### How to get your Firebase Service Account key

1. Go to the [Firebase Console](https://console.firebase.google.com/) and select your project.
2. Click the gear icon → **Project settings** → **Service accounts** tab.
3. Click **Generate new private key** and download the JSON file.
4. Save it as `serviceAccountKey.json` in your project root.
5. Either reference its path via `FIREBASE_SERVICE_ACCOUNT_KEY_PATH` in `.env` (Option A), or copy its contents into the individual env vars (Option B).

### 4. Configure your IDs

Open your configuration file (e.g., `config.js` or similar) and verify it reads from `process.env`:

```js
module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  categoryId: process.env.CATEGORY_ID,
  firebase: {
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH,
    // Or individual fields:
    // projectId: process.env.FIREBASE_PROJECT_ID,
    // clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // privateKey: process.env.FIREBASE_PRIVATE_KEY,
  },
};
```

Replace any placeholder IDs with your actual values from the `.env` file.

### 5. Run the Bot

```bash
npm run start
```

The bot will log into Discord, register slash commands (in your test guild), and connect to Firebase. Check the console for any errors.

## Commands & Usage

* `/help` – Lists all available commands and their descriptions.
* `/createTeam <name>` – Creates a new team under the configured category.
* `/addPlayer <team> <player>` – Adds a player to a team.
* `/matchmake` – Starts a matchmaking session.

*(Refer to the **`commands/`** folder for full details on each command.)*

## Contributing

1. Fork the repository
2. Create a new branch (`git checkout -b feature/YourFeature`)
3. Commit your changes (`git commit -m "Add some feature"`)
4. Push to the branch (`git push origin feature/YourFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
