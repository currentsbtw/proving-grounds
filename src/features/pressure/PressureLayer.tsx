import ClockBanner from './ClockBanner';
import EventDock from './EventDock';
import './pressure.css';

/**
 * Everything that sits above the battlefield: the standing race clock first,
 * then whatever the pod is currently asking you to answer. Renders nothing at
 * all when the pod is quiet, so the table keeps its full height.
 */
export default function PressureLayer() {
  return (
    <div className="pgp-layer">
      <ClockBanner />
      <EventDock />
    </div>
  );
}
