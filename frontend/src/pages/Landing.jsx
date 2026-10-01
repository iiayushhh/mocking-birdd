import { useNavigate } from "react-router-dom";

// Simple role picker — this is the first thing anyone sees when they
// open the app on the classroom wifi.
export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="landing">
      <h1>MockingBird</h1>
      <p className="tagline">Classroom file relay — built for our hackathon at Axis HackSprint.</p>

      <div className="role-cards">
        <button className="role-card" onClick={() => navigate("/teacher")}>
          <span className="role-icon">🧑‍🏫</span>
          <span>I'm the Teacher</span>
        </button>

        <button className="role-card" onClick={() => navigate("/student")}>
          <span className="role-icon">🎓</span>
          <span>I'm a Student</span>
        </button>
      </div>

      <p className="footnote">
        Files are relayed through gofile.io — make sure the FastAPI bridge is running.
      </p>
    </div>
  );
}
