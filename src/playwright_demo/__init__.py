"""Thin Python host for the Node UI validation engine."""

from .host import HostCallResult, HostProcessFailure, call_node
from .report_projection import call_report_projection

__all__ = ["HostCallResult", "HostProcessFailure", "call_node", "call_report_projection"]


def main() -> None:
    """Preserve the scaffold console entry until host UX is documented in P2-3E."""
    print("Hello from playwright-demo!")
