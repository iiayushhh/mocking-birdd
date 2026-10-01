import { BrowserRouter, Routes, Route } from "react-router-dom";
import Landing from "./pages/Landing";
import TeacherDashboard from "./pages/TeacherDashboard";
import StudentView from "./pages/StudentView";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/teacher" element={<TeacherDashboard />} />
        <Route path="/student" element={<StudentView />} />
      </Routes>
    </BrowserRouter>
  );
}
