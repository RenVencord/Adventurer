# <img src="assets/logo.png" height="24px"> Adventurer
A Vencord plugin to automate Discord Quests.

## Features
- Freely tab out of video quests
- Spoof game exes for play quests
- One click experiences quests with ESP
- Notifications when new quests are available
- Randomized open and close times
- Companion app for spoofing game exes and tracking quests

## Functionality

### Video Quests
- **Precise** targets the video player HTML element (default)
- **Quest** ID Match finds the quest ID in the video player HTML element and searches it in users active quests
- **Duration** Match searches for videos that match the duration of users active quests
- **Permissive** prevents pausing on any videos longer than 10 seconds

### Game Quests
- **Internal** actively registers a `RUNNING_GAME_SET_DEBUG_GAME` activity (riskier)
  - **Quest Start Delay Min** sets the minimum delay for starting and ending the activity
  - **Quest Start Delay Max** sets the maximum delay for starting and ending the activity
- **Server** utilizes the optional companion app to spawn a stub game process that matches Discord's exe (safer)

### Experiences Quests
- **Primary Color** sets the color for orb related quest items
- **Secondary Color** sets the color for any interactable items
- **Highlight Color** sets the color when highlighting an item

### Notifications
- **Server Port** sets the port for the companion app
- **Notify New Quests** toggles whether to notify when new quests are available
  - **Notify Orbs Only** only notifies when the quest rewards orbs
  - **Notify Min Orbs** the minimum number of orbs a quest will award to notify
  - **Notify Video Quests** toggles whether to notify when a video quest is available

## Usage
I will hopefully have a build in release soon, but for now:
1. [Build Vencord](https://docs.vencord.dev/installing/)
2. Clone this repository
    ```bash
    git clone https://github.com/RenVencord/Adventurer.git
    ```
3. Copy the `adventurer` folder into `Vencord/src/userplugins`
4. **Optional:** For the companion app, download [Python >=3.7](https://www.python.org/downloads/)
5. Install requirements
    ```bash
   pip install -r requirements.txt
    ```
6. Start the companion app
    ```bash
   python server.py
    ```

## Planned Features
- Better multi-account management
- Better log output management
- Quest claim fanfare
- Experiences volume control
- Better quest page direct
- Plugin installer and auto updater