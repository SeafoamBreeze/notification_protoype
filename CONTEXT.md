# AV Booking Notification Platform

Platform for onboarding multiple autonomous-vehicle (AV) services, with a notification path that delivers significant events to riders via the Breeze mobile app.

## Language

### Tenancy

**AV Service**:
A tenant: one of multiple autonomous-vehicle operators onboarded onto the platform. All domain events carry the AV Service they belong to.
_Avoid_: operator, provider, client

**Rider**:
A person who books and rides an AV through the platform.
_Avoid_: user, customer, passenger

**Breeze**:
The riders' mobile app. A black box owned by another team; the only known integration surface is the Breeze API.

### Booking

**AV Booking**:
A reservation of an autonomous vehicle, created by a rider completing the booking form in the web app.

**Service Mode**:
How an AV Service operates: either **Fixed route and schedule** or **On-demand**, configurable by day and time.

**Booking Confirmation**:
The state in which a submitted AV Booking has been accepted. A Significant Event.

**Arrival Warning**:
The Significant Event fired when the assigned vehicle is expected to arrive within 10 minutes.

### Events and notifications

**Domain Event**:
A fact that something happened in the platform (e.g. a booking was confirmed), published by the service that observed it. Producers state what happened, never what should be done about it.
_Avoid_: message, record, notification

**Significant Event**:
A low-frequency, rider-actionable Domain Event (Booking Confirmation, Arrival Warning, Service Disruption) that travels through the notification path. Distinct from high-frequency telemetry such as live ETA updates, which do not.

**Service Disruption**:
A Significant Event indicating a fixed route or schedule is affected. Targeted at riders of the affected AV Service, not a single rider.

### Demonstration

**Scenario Simulator**:
The demonstration mechanism (buttons in the UI) that publishes Domain Events through the real broker path without the real underlying functionality.

**BreezeClient**:
The adapter seam in the notification service through which messages are delivered to Breeze. A mock stands in during the prototype; the real HTTP adapter is slotted in when the Breeze API spec arrives.
