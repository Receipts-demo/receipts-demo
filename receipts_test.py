import anthropic
import os
import requests

GOODTAPE_API_KEY = os.environ["GOODTAPE_API_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
AUDIO_FILE_PATH = "memo.m4a"

# Step 1: Transcribe audio with Good Tape
with open(AUDIO_FILE_PATH, "rb") as audio_file:
    response = requests.post(
        "https://api.goodtape.io/transcribe/sync",
        headers={"Authorization": GOODTAPE_API_KEY},
        files={"audio": audio_file},
    )
    response.raise_for_status()
    transcript = response.json()["text"]

print(f"Transcript:\n{transcript}\n")

# Step 2: Send transcript to Claude
client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

message = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=1024,
    system=(
        "you are a professional build logger. Take this raw voice note transcript and turn it into "
        "a single, precise, timestamped claim statement in this format: a one sentence description "
        "of what was built, decided, or originated - written as professional evidence, not a diary "
        "entry. Return only the claim, nothing else."
    ),
    messages=[{"role": "user", "content": transcript}],
)

claim = message.content[0].text
print(f"Claim:\n{claim}")
