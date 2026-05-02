"""Claude Sonnet event extraction.

Uses `client.messages.parse()` with a Pydantic schema for typed structured output.
The system prompt is cached (`cache_control: ephemeral`) so processing many
emails in one cron run only pays full input price for the first one.
"""

from __future__ import annotations

import logging
from typing import List, Optional

import anthropic
from pydantic import BaseModel, Field

from .config import Settings


log = logging.getLogger(__name__)


class Event(BaseModel):
    name: str = Field(description="Short event title.")
    date: Optional[str] = Field(
        default=None, description="ISO YYYY-MM-DD, or null if not specified."
    )
    end_date: Optional[str] = Field(
        default=None,
        description="ISO YYYY-MM-DD for the last day of a multi-day event, or null.",
    )
    time: Optional[str] = Field(
        default=None, description="Free-form time string, e.g. '8pm', 'All day'."
    )
    location: Optional[str] = Field(default=None, description="Venue name or address.")
    neighborhood: Optional[str] = Field(
        default=None,
        description="NYC neighborhood, e.g. 'Williamsburg', 'Lower East Side'.",
    )
    price: Optional[str] = Field(
        default=None, description="Free-form price, e.g. 'Free', '$25', '$25-50'."
    )
    link: Optional[str] = Field(default=None, description="URL for tickets or info.")
    blurb: Optional[str] = Field(default=None, description="1-2 sentence description.")
    tags: List[str] = Field(
        default_factory=list,
        description="Categorical tags, e.g. ['music', 'outdoor', 'food'].",
    )


class EventList(BaseModel):
    events: List[Event]


SYSTEM_PROMPT = """\
You extract NYC events from newsletter emails.

Read the email and return a JSON object with an "events" array. Each event \
should have a name and as many of the optional fields as the email actually \
specifies — leave a field null if it is not mentioned. Do not invent details.

Dates: convert relative dates like "this Saturday" to ISO YYYY-MM-DD using \
the email's received-at date as the reference point if you can infer it from \
the email; otherwise leave date null.

Neighborhood: only fill in if the email names a NYC neighborhood explicitly \
or via a venue you are highly confident about.

Tags: choose from a small open vocabulary like music, food, art, outdoor, \
nightlife, family, theater, film, talk, market, festival, free, ticketed.

If the email contains no actual events (e.g. it's a marketing pitch or a \
"thanks for subscribing" message), return {"events": []}.\
"""


def extract_events(settings: Settings, email_text: str) -> list[dict]:
    """Run Claude Sonnet on one email body; return a list of plain dicts."""
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    response = client.messages.parse(
        model=settings.claude_model,
        max_tokens=4096,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": (
                    "Extract events from this newsletter email:\n\n"
                    "<email>\n" + email_text + "\n</email>"
                ),
            }
        ],
        output_format=EventList,
    )

    usage = getattr(response, "usage", None)
    if usage is not None:
        log.debug(
            "extract usage: input=%s cache_read=%s cache_write=%s output=%s",
            getattr(usage, "input_tokens", "?"),
            getattr(usage, "cache_read_input_tokens", "?"),
            getattr(usage, "cache_creation_input_tokens", "?"),
            getattr(usage, "output_tokens", "?"),
        )

    parsed: EventList | None = response.parsed_output
    if parsed is None:
        # Model produced text that didn't validate — surface as an error upstream.
        raise RuntimeError("Claude returned unparseable output for this email")
    return [e.model_dump() for e in parsed.events]
