# [Product Name] — Behavioral Core

> Single source of truth for all AI behavioral decisions. Code must implement this exactly.

## 1. Decision Framework
- How does the system decide what action to take?
- What are the confidence levels? (High / Medium / Low)
- What happens at each level? (Act / Act+Confirm / Clarify)
- What scoring or ranking logic is used?

## 2. Autonomy Boundaries
- What can the system do WITHOUT asking the user?
- What requires user CONFIRMATION before acting?
- What does the system REFUSE to do?
- What happens when the system is unsure which category applies?

## 3. Communication Style
- Default tone (formal / conversational / terse / warm)
- Message length constraints (by channel — SMS, email, portal)
- How it handles: bad news, reminders, errors, celebrations
- Escalation pattern: what does it say when it can't help?

## 4. Absolute Constraints
- [NEVER]: Things the system must never do (list exhaustively)
- [ALWAYS]: Things the system must always do (list exhaustively)
- These override all other rules. No confidence threshold or edge case bypasses them.

## 5. Conflict Resolution
- When two rules point in different directions, which wins?
- Priority hierarchy: Safety > Absolute Constraints > User Preference > Efficiency
- When subsystems disagree, resolution rules

## 6. Memory & Context
- What does the system remember about the user?
- How long does context persist? (Session / 24h / Forever)
- How does it use past interactions to inform current behavior?
- What does it forget (and why)?

## 7. Error Behavior
- System is uncertain → [behavior]
- System made a mistake → [behavior]
- External service fails → [behavior]
- User is confused or frustrated → [behavior]

## 8. Output Templates (per channel)
- Define exact message templates with field placeholders for each output type
- SMS templates: max length, truncation rules, deep link format
- Email templates: subject line pattern, body structure
- Portal notifications: format, grouping rules
- Rule: If a message type doesn't have a template, it doesn't get sent

## 9. Temporal Constants
- List ALL time-based thresholds as named values (not magic numbers)
- Example: correction_window=60s, session_timeout=10min, cooldown=30d
- These are defined HERE, not discovered during implementation

## 10. State Mutation Rules
- Which actions auto-execute vs require confirmation?
- Define per action type: [action] → [auto-execute? Y/N] → [confirmation required? Y/N]
- High-risk actions (deletion, financial, medical) → ALWAYS confirm regardless of confidence
- Rule: Never confirm an action that didn't actually happen
