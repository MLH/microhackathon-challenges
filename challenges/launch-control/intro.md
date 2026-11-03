You run the travel desk, and its booking agent needs work. Ask it to plan
a trip, then watch it get better, live, while it keeps running.

The booker reads its whole setup from LaunchDarkly AgentControl: which
model it runs, what its instructions say, and which tools it may use. Pi,
your guide on the right, changes that setup one rung at a time:

- v1: a small model and a one-line prompt
- v2: a real travel-agent prompt
- v3: tools to search flights and hotels, and to book
- v4: a stronger model

After each switch, send your trip again and compare. The Live config card
shows what LaunchDarkly serves the booker right now. Nothing restarts and
nothing is redeployed.

The travel desk is in Chrome on the left. Its flights and hotels are made
up, and nothing is ever charged.
